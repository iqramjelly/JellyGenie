#!/usr/bin/env node
// Genie Dispatcher — spawns a Claude Code subprocess as the execution engine.
//
// Replaces the old interpreter→executor pipeline. When the Genie server detects
// the "genie" keyword in a JellyJelly transcript, it calls dispatchToClaude(),
// which spawns `claude -p` with our system prompt, the Playwright MCP config,
// and full tool access. Stream-json events from the child are parsed live and
// forwarded as Telegram status updates.

import { spawn, execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import {
  createDispatch, markRunning, markDone, markCancelled, markError,
  getDispatch, getRunningDispatches, shouldRetry, updateDispatch, cancelDispatch,
} from './dispatch-registry.mjs';

import { sendMessage } from './telegram.mjs';

// ─── Shared config (~/.jellygenie/config.json) ──────────────────────────────
const GENIE_CONFIG_PATH = resolve(homedir(), '.jellygenie', 'config.json');

function loadGenieConfig() {
  try {
    if (existsSync(GENIE_CONFIG_PATH)) {
      return JSON.parse(readFileSync(GENIE_CONFIG_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
// Find claude binary: env override → PATH lookup → common locations
const CLAUDE_BIN = process.env.GENIE_CLAUDE_BIN
  || (() => { try { return execSync('which claude', { encoding: 'utf-8' }).trim(); } catch { return null; } })()
  || (existsSync('/usr/local/bin/claude') ? '/usr/local/bin/claude' : null)
  || (existsSync(`${process.env.HOME}/.local/bin/claude`) ? `${process.env.HOME}/.local/bin/claude` : null)
  || 'claude';
const SYSTEM_PROMPT_PATH = resolve(REPO_ROOT, 'config/genie-system.md');
const SKILLS_DIR = resolve(REPO_ROOT, 'config/skills');
const MCP_CONFIG_PATH = resolve(REPO_ROOT, 'config/mcp.json');
// Hard timeout is a safety net against a truly stuck process, not a task time budget.
// Default: 60 min. Set GENIE_CLAUDE_TIMEOUT_MS=0 to disable entirely.
const HARD_TIMEOUT_MS = parseInt(process.env.GENIE_CLAUDE_TIMEOUT_MS || String(60 * 60 * 1000), 10);

// Telegram throttle — don't flood the chat with tool-use pings
const TELEGRAM_MIN_INTERVAL_MS = 1500;

// ─── Triage: classify wish complexity to pick the right model + turn budget ──
const SKILL_KEYWORDS = {
  'build-deploy': /\b(build|site|website|page|deploy|landing|html)\b/i,
  'ubereats':     /\b(order|food|eat|drink|uber|deliver|grocery|snack)\b/i,
  'stripe':       /\b(pay|invoice|stripe|charge|link|checkout|price)\b/i,
  'outreach':     /\b(linkedin|twitter|email|dm|message|outreach|post|tweet|gmail)\b/i,
  'research':     /\b(research|find out|who is|look up|search|investigate)\b/i,
};

function triageWish(transcript) {
  const matchedSkills = [];
  for (const [skill, pattern] of Object.entries(SKILL_KEYWORDS)) {
    if (pattern.test(transcript)) matchedSkills.push(skill);
  }

  // Check free-only mode: config file toggle or env var
  const config = loadGenieConfig();
  const freeOnly = config.freeOnly === true || process.env.GENIE_FREE_ONLY === '1';

  // Complexity based on how many skill domains the wish touches
  // Free-only: always haiku with minimal budget ($0.10 cap)
  let complexity, model, maxTurns;
  if (matchedSkills.length === 0) {
    complexity = 'simple';
    model = freeOnly ? 'haiku' : (process.env.GENIE_CLAUDE_MODEL || 'haiku');
    maxTurns = freeOnly ? '10' : '15';
  } else if (matchedSkills.length === 1 && matchedSkills[0] === 'research') {
    complexity = 'simple';
    model = freeOnly ? 'haiku' : (process.env.GENIE_CLAUDE_MODEL || 'haiku');
    maxTurns = freeOnly ? '10' : '20';
  } else if (matchedSkills.length <= 2) {
    complexity = 'moderate';
    model = freeOnly ? 'haiku' : (process.env.GENIE_CLAUDE_MODEL || 'sonnet');
    maxTurns = freeOnly ? '15' : '50';
  } else {
    complexity = 'complex';
    model = freeOnly ? 'haiku' : (process.env.GENIE_CLAUDE_MODEL || 'sonnet');
    maxTurns = freeOnly ? '15' : '200';
  }

  // If user explicitly set the model (and not in free-only mode), always use it
  if (process.env.GENIE_CLAUDE_MODEL && !freeOnly) {
    model = process.env.GENIE_CLAUDE_MODEL;
  }
  // If user explicitly set max turns, always use it
  if (process.env.GENIE_MAX_TURNS) {
    maxTurns = process.env.GENIE_MAX_TURNS;
  }

  if (freeOnly) {
    log('MODE', `Free-only mode ON — haiku with $0.10 budget cap, ${maxTurns} turns max`);
  }

  return { complexity, model, maxTurns, matchedSkills, freeOnly };
}

// Build system prompt: core + only the skill sections the wish needs
function buildSystemPrompt(matchedSkills, creator = 'user') {
  let systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
  systemPrompt = systemPrompt.replaceAll('{{USERNAME}}', creator);

  // If split skill files exist, append only the relevant ones
  if (existsSync(SKILLS_DIR)) {
    for (const skill of matchedSkills) {
      const skillPath = resolve(SKILLS_DIR, `${skill}.md`);
      if (existsSync(skillPath)) {
        systemPrompt += '\n\n' + readFileSync(skillPath, 'utf-8');
      }
    }
  }

  return systemPrompt;
}

// Free models — tried in order. If one is deprecated/down, falls through to the next.
// NOTE: If the account has a high OpenRouter balance, "free-models-per-day-high-balance"
// rate limit kicks in and ALL free models will fail. In that case, use freeOnly:false.
const FREE_MODELS = [
  'openai/gpt-oss-20b:free',                  // GPT OSS 20B, good general model
  'openai/gpt-oss-120b:free',                  // GPT OSS 120B, strong
  'google/gemma-4-26b-a4b-it:free',            // Gemma 4 26B
  'google/gemma-4-31b-it:free',                // 262K ctx, strong general
  'qwen/qwen3-coder:free',                    // 262K ctx, great for code
  'nvidia/nemotron-3-super-120b-a12b:free',    // 262K ctx, large
  'qwen/qwen3-next-80b-a3b-instruct:free',    // 262K ctx
];
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function log(tag, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [GENIE] [DISPATCH:${tag}] ${msg}`);
}

/**
 * Dispatch a wish to a free OpenRouter model (no Claude, zero cost).
 * Tries models in FREE_MODELS order — if one is deprecated/down, tries the next.
 */
async function dispatchToFreeModel({ transcript, clipTitle, creator, clipId, keyword }) {
  const startedAt = Date.now();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('your-key')) {
    const err = 'OPENROUTER_API_KEY not set — cannot use free mode';
    log('ERR', err);
    return { success: false, result: null, turns: 1, usdCost: 0, durationMs: 0, error: err, model: null };
  }

  const systemPrompt = (existsSync(SYSTEM_PROMPT_PATH)
    ? readFileSync(SYSTEM_PROMPT_PATH, 'utf-8')
    : 'You are Genie, a helpful assistant. Respond concisely.'
  ).replaceAll('{{USERNAME}}', creator);

  const userPrompt = [
    `A user named ${creator} said "${keyword}" on a JellyJelly video.`,
    ``,
    `Title: ${clipTitle}`,
    `Creator: @${creator}`,
    ``,
    `Transcript:`,
    transcript,
    ``,
    `Interpret what ${creator} wants and respond with a helpful, complete answer.`,
    `Be concise but thorough. This is a text-only response (no tool use).`,
  ].join('\n');

  const messages = [
    { role: 'system', content: systemPrompt.slice(0, 4000) },
    { role: 'user', content: userPrompt },
  ];

  // Try each free model in order
  for (const model of FREE_MODELS) {
    log('FREE', `Trying ${model} via OpenRouter...`);

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://genie.jellyjelly.com',
        },
        body: JSON.stringify({ model, messages, max_tokens: 2000 }),
      });

      const data = await res.json();

      if (data.error) {
        log('FREE', `${model} error: ${data.error.message || JSON.stringify(data.error)} — trying next...`);
        continue; // try next model
      }

      const result = data.choices?.[0]?.message?.content || '(no response)';
      const durationMs = Date.now() - startedAt;

      log('FREE', `${model} — done in ${(durationMs / 1000).toFixed(1)}s, ${result.length} chars`);

      return { success: true, result, turns: 1, usdCost: 0, durationMs, error: null, model };
    } catch (err) {
      log('FREE', `${model} fetch failed: ${err.message} — trying next...`);
      continue;
    }
  }

  // All models failed
  const durationMs = Date.now() - startedAt;
  const err = `All free models failed: ${FREE_MODELS.join(', ')}`;
  log('FREE', err);
  return { success: false, result: null, turns: 1, usdCost: 0, durationMs, error: err, model: null };
}

// Split a long string into Telegram-safe chunks (4096 char limit, we use 3800).
function chunkText(text, size = 3800) {
  if (!text) return [];
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

async function sendChunked(prefix, text) {
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    const p = chunks.length > 1 ? `${prefix} (${i + 1}/${chunks.length})\n` : `${prefix}\n`;
    await sendMessage(p + chunks[i], { plain: true });
  }
}

function buildUserPrompt({ transcript, clipTitle, creator, clipId, keyword }) {
  return [
    `A human named ${creator} just triggered you by saying the word "${keyword}" on a JellyJelly video.`,
    ``,
    `--- CLIP METADATA ---`,
    `Clip ID: ${clipId}`,
    `Title: ${clipTitle}`,
    `Creator: @${creator}`,
    ``,
    `--- RAW TRANSCRIPT ---`,
    transcript,
    `--- END TRANSCRIPT ---`,
    ``,
    `Interpret the transcript. ${creator}'s wish begins near the word "${keyword}" but may span the whole clip. Extract what they actually want you to do — concretely, in plain English — and then DO it end-to-end using your tools. Report progress and the final receipt to ${creator} on Telegram per your system instructions.`,
    ``,
    `Do not reply to me in text. The only way ${creator} hears from you is Telegram. Use your tools.`,
  ].join('\n');
}

function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  try {
    if (toolName === 'Bash') return String(input.command || '').slice(0, 140);
    if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
      return String(input.file_path || input.path || '').slice(0, 140);
    }
    if (toolName === 'WebFetch' || toolName === 'WebSearch') {
      return String(input.url || input.query || '').slice(0, 140);
    }
    if (toolName === 'TodoWrite') {
      const todos = input.todos || [];
      return `${todos.length} todos`;
    }
    if (toolName === 'Task') {
      return String(input.description || input.subagent_type || '').slice(0, 140);
    }
    if (toolName.startsWith('mcp__playwright__') || toolName.includes('browser_')) {
      return String(input.url || input.selector || input.text || JSON.stringify(input)).slice(0, 140);
    }
    const s = JSON.stringify(input);
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  } catch {
    return '';
  }
}

/**
 * Dispatch a Genie wish to a spawned Claude Code subprocess.
 * Streams events back to Telegram as they arrive.
 *
 * @param {object} args
 * @param {string} args.transcript
 * @param {string} args.clipTitle
 * @param {string} args.creator
 * @param {string} args.clipId
 * @param {string} args.keyword
 * @returns {Promise<{success:boolean, sessionId:?string, result:?string, turns:?number, usdCost:?number, durationMs:number, exitCode:?number, error:?string}>}
 */
export async function dispatchToClaude({ transcript, clipTitle, creator, clipId, keyword }) {
  const startedAt = Date.now();

  // ─── Retry guard: skip clips with too many consecutive failures ────────────
  if (!clipId.startsWith('chat-') && !shouldRetry(clipId)) {
    log('SKIP', `Clip ${clipId} has too many failures — skipping`);
    return { success: false, result: null, turns: null, usdCost: null, durationMs: 0, exitCode: null, error: 'max retries exceeded' };
  }

  // ─── Triage the wish to pick model, turns, and relevant skill sections ───
  const triage = triageWish(transcript);

  // ─── Free mode: use OpenRouter free model, skip Claude entirely ───────────
  if (triage.freeOnly) {
    createDispatch({ clipId, clipTitle, creator });
    markRunning(clipId, null);
    const freeResult = await dispatchToFreeModel({ transcript, clipTitle, creator, clipId, keyword });
    if (freeResult.success) {
      markDone(clipId, { result: freeResult.result, turns: 1, usdCost: 0, model: freeResult.model });
    } else {
      markError(clipId, freeResult.error);
    }
    await sendUnifiedResult({ ...freeResult, clipTitle, clipId, durationMs: freeResult.durationMs, model: freeResult.model || 'free' });
    return { ...freeResult, sessionId: null, exitCode: freeResult.success ? 0 : 1 };
  }

  // ─── Paid mode: spawn Claude CLI ──────────────────────────────────────────
  if (!existsSync(CLAUDE_BIN)) {
    const err = `claude CLI not found at ${CLAUDE_BIN}`;
    log('ERR', err);
    await sendMessage(`❌ Genie dispatcher error: ${err}`);
    return { success: false, sessionId: null, result: null, turns: null, usdCost: null, durationMs: 0, exitCode: null, error: err };
  }
  if (!existsSync(SYSTEM_PROMPT_PATH)) {
    const err = `system prompt missing at ${SYSTEM_PROMPT_PATH}`;
    log('ERR', err);
    await sendMessage(`❌ Genie dispatcher error: ${err}`);
    return { success: false, sessionId: null, result: null, turns: null, usdCost: null, durationMs: 0, exitCode: null, error: err };
  }
  const systemPrompt = buildSystemPrompt(triage.matchedSkills, creator);
  const userPrompt = buildUserPrompt({ transcript, clipTitle, creator, clipId, keyword });

  // Simple wishes (research, quick lookups) get a leaner toolset — no browser needed
  const needsBrowser = triage.matchedSkills.some(s => ['outreach', 'ubereats', 'build-deploy'].includes(s));
  const allowedTools = needsBrowser
    ? ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'mcp__playwright'].join(',')
    : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'].join(',');

  const args = [
    '-p',
    '--model', triage.model,
    '--append-system-prompt', systemPrompt,
    ...(needsBrowser ? ['--mcp-config', MCP_CONFIG_PATH] : []),
    '--allowedTools', allowedTools,
    '--permission-mode', 'bypassPermissions',
    '--max-turns', triage.maxTurns,
    '--max-budget-usd', triage.freeOnly ? '0.10' : (process.env.GENIE_MAX_BUDGET_USD || '25'),
    '--output-format', 'stream-json',
    '--verbose',
    '--add-dir', REPO_ROOT,
  ];

  log('SPAWN', `Triage: ${triage.complexity} | model=${triage.model} | turns=${triage.maxTurns} | skills=[${triage.matchedSkills}] | browser=${needsBrowser}`);
  log('SPAWN', `Spawning claude -p (prompt ${userPrompt.length} chars, system ${systemPrompt.length} chars)`);

  // Register in persistent dispatch registry
  createDispatch({ clipId, clipTitle, creator });

  const child = spawn(CLAUDE_BIN, args, {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  markRunning(clipId, child.pid);

  // Pipe the user prompt to stdin and close it.
  child.stdin.write(userPrompt);
  child.stdin.end();

  let sessionId = null;
  let finalResult = null;
  let turns = null;
  let usdCost = null;
  let numTurnsFromResult = null;
  let stderrBuf = '';
  let stdoutBuf = '';
  // Tool-use updates are logged locally only — no Telegram spam.
  // Only 3 Telegram messages per wish: spawn, receipt, footer.
  let toolCount = 0;
  // Post the TodoWrite plan to JellyJelly chat the first time it fires.
  let planPosted = false;
  // Buffer assistant text blocks so we can salvage something on timeout/failure
  // (when no `result` event ever arrives).
  let assistantTextBuffer = '';

  const handleEvent = async (evt) => {
    if (!evt || typeof evt !== 'object') return;
    const t = evt.type;

    if (t === 'system' && evt.subtype === 'init') {
      sessionId = evt.session_id || null;
      log('EVT', `system.init session=${sessionId} model=${evt.model || '?'}`);
      await sendMessage(`🧞 Claude Code spawned. Session ${(sessionId || 'n/a').slice(0, 8)} thinking…`, { plain: true });
      return;
    }

    if (t === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_use') {
          const name = block.name || 'tool';
          const brief = summarizeToolInput(name, block.input);
          toolCount++;
          log('EVT', `tool_use #${toolCount} ${name} ${brief}`);
          // First TodoWrite → post the plan to JellyJelly chat
          if (name === 'TodoWrite' && !planPosted && Array.isArray(block.input?.todos)) {
            planPosted = true;
            postPlanToChat(clipId, block.input.todos).catch(err =>
              log('PLAN', `Failed to post plan: ${err.message}`)
            );
          }
        } else if (block.type === 'text' && block.text && block.text.trim()) {
          log('EVT', `text: ${block.text.slice(0, 120).replace(/\n/g, ' ')}`);
          assistantTextBuffer += (assistantTextBuffer ? '\n\n' : '') + block.text.trim();
        }
      }
      return;
    }

    if (t === 'user' && evt.message && Array.isArray(evt.message.content)) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_result' && block.is_error) {
          const errText = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content).slice(0, 500);
          log('EVT', `tool_result ERROR: ${errText.slice(0, 200)}`);
          // Only log errors locally — no Telegram
        }
      }
      return;
    }

    if (t === 'result') {
      finalResult = evt.result || evt.message || null;
      numTurnsFromResult = evt.num_turns ?? null;
      usdCost = evt.total_cost_usd ?? evt.cost_usd ?? null;
      turns = numTurnsFromResult;
      log('EVT', `result turns=${turns} cost=${usdCost} len=${(finalResult || '').length}`);
      return;
    }
  };

  // Line-buffered stdout parser.
  child.stdout.on('data', (buf) => {
    stdoutBuf += buf.toString('utf-8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch (err) {
        log('PARSE', `non-json line: ${line.slice(0, 200)}`);
        continue;
      }
      // Fire and forget — we don't want to block the stream on Telegram latency
      handleEvent(evt).catch((err) => log('EVT-ERR', err.message));
    }
  });

  child.stderr.on('data', (buf) => {
    const s = buf.toString('utf-8');
    stderrBuf += s;
    for (const line of s.split('\n')) {
      if (line.trim()) log('STDERR', line.trim().slice(0, 300));
    }
  });

  // Hard timeout — only armed if HARD_TIMEOUT_MS > 0. Safety net for a truly stuck process.
  let killed = false;
  let timeoutHandle = null;
  if (HARD_TIMEOUT_MS > 0) {
    timeoutHandle = setTimeout(() => {
      killed = true;
      log('TIMEOUT', `Killing child after ${HARD_TIMEOUT_MS}ms (safety net, not a task budget)`);
      sendMessage(`⏰ Genie hit ${Math.round(HARD_TIMEOUT_MS / 60000)}min safety timeout — killing subprocess.`, { plain: true }).catch(() => {});
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }, HARD_TIMEOUT_MS);
  }

  const exitCode = await new Promise((resolvePromise) => {
    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolvePromise(code);
    });
    child.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      log('CHILD-ERR', err.message);
      resolvePromise(-1);
    });
  });

  const durationMs = Date.now() - startedAt;
  const success = exitCode === 0 && !killed;

  log('EXIT', `code=${exitCode} killed=${killed} duration=${durationMs}ms turns=${turns} cost=${usdCost}`);

  // Update persistent registry
  if (killed) {
    markError(clipId, 'timeout');
  } else if (success) {
    markDone(clipId, { result: (finalResult || '').slice(0, 500), turns, usdCost, model: triage.model });
  } else {
    markError(clipId, `exit ${exitCode}`);
  }

  // Unified result → Telegram + JellyJelly chat (same message)
  await sendUnifiedResult({
    success, result: finalResult, turns, usdCost, durationMs,
    clipTitle, clipId, exitCode, killed,
    model: triage.model,
    stderrTail: success ? null : (stderrBuf.slice(-1500) || null),
    assistantText: assistantTextBuffer || null,
  });

  return {
    success,
    sessionId,
    result: finalResult,
    turns,
    usdCost,
    durationMs,
    exitCode,
    error: success ? null : (killed ? 'timeout' : `exit ${exitCode}`),
  };
}

// ─── Post the TodoWrite plan to JellyJelly chat ──────────────────────────────

const STATUS_ICON = { pending: '⏳', in_progress: '🔄', completed: '✅' };

async function postPlanToChat(clipId, todos) {
  try {
    const jellyChat = await import('./jelly-chat.mjs').catch(() => null);
    if (!jellyChat) return;
    await jellyChat.connectChat();
    const roomId = jellyChat.getRoomForClip(clipId);
    if (!roomId) {
      log('PLAN', `No JellyJelly room for clip ${clipId} — skipping plan post`);
      return;
    }
    const lines = todos.map((t, i) => {
      const icon = STATUS_ICON[t.status] || '⏳';
      const text = (t.activeForm || t.content || '').trim();
      return `${i + 1}. ${icon} ${text}`;
    });
    const message = `🧞 Here's my plan:\n\n${lines.join('\n')}`;
    await jellyChat.sendChatMessage(roomId, message);
    log('PLAN', `Posted plan to chat for clip ${clipId} (${todos.length} todos)`);
  } catch (err) {
    log('PLAN', `postPlanToChat error: ${err.message}`);
  }
}

// ─── Unified result: same message to Telegram + JellyJelly chat ─────────────

async function sendUnifiedResult({ success, result, turns, usdCost, durationMs, clipTitle, clipId, exitCode, killed, model, stderrTail, assistantText }) {
  const costStr = `$${(usdCost ?? 0).toFixed(3)}`;
  const durationStr = `${(durationMs / 1000).toFixed(1)}s`;
  const modelStr = model || 'unknown';

  // If the run was killed mid-flight (timeout), there's no `result` event but
  // we may still have buffered assistant text — use that as the salvage output.
  const salvage = (!result && assistantText) ? assistantText : null;
  const outputText = result || salvage || null;

  // Telegram gets full technical detail
  let telegramMsg;
  if (success && result) {
    telegramMsg = `🧞 GENIE RECEIPT\n\n${result}\n\n✅ ${turns ?? '?'} turns · ${costStr} · ${durationStr} · ${modelStr}`;
  } else if (success) {
    telegramMsg = `🧞 Genie finished but returned no result text.\n✅ ${turns ?? '?'} turns · ${costStr} · ${durationStr} · ${modelStr}`;
  } else {
    telegramMsg = `❌ Genie failed (exit ${exitCode ?? '?'}${killed ? ', timeout' : ''}) after ${durationStr}`;
    if (salvage) telegramMsg += `\n\n--- partial output ---\n${salvage.slice(0, 2000)}`;
    if (stderrTail) telegramMsg += `\n\nstderr:\n${stderrTail.slice(0, 1000)}`;
  }

  // Jelly chat gets a clean, nicely spaced version with some emojis
  const cleanForChat = (text) => text
    .replace(/<br\s*\/?>/gi, '\n')     // convert <br> to newlines
    .replace(/<[^>]+>/g, '')           // strip all HTML tags
    .replace(/&amp;/g, '&')           // decode HTML entities
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')       // collapse triple+ newlines
    .replace(/^[-•]\s*/gm, '  • ')    // normalize bullet points
    .trim();

  let chatMsg;
  if (success && result) {
    chatMsg = `🧞 Wish granted!\n\n${cleanForChat(result)}\n\n✅ Done in ${durationStr}`;
  } else if (success) {
    chatMsg = `🧞 Done! Took ${durationStr}.`;
  } else if (salvage) {
    // Killed/failed but we have partial reasoning — surface it instead of "something went wrong"
    chatMsg = `🧞 I ran out of time before I could finish, but here's what I had so far:\n\n${cleanForChat(salvage)}\n\n⏰ Stopped after ${durationStr}`;
  } else {
    chatMsg = `🧞 Something went wrong — I couldn't complete this wish.\n\nTook ${durationStr}`;
  }

  // 1) Telegram
  await sendChunked('', telegramMsg);

  // 2) JellyJelly group chat — same message, plus jelly clip + reply monitoring
  // Skip for follow-up replies (clipId starts with 'chat-') — those already have a room
  const isFollowUp = clipId && clipId.startsWith('chat-');
  try {
    const jellyChat = await import('./jelly-chat.mjs').catch(() => null);
    if (jellyChat && clipId && !isFollowUp) {
      await jellyChat.connectChat();
      const roomName = clipTitle || 'Genie Wish';
      const isExisting = !!jellyChat.getRoomForClip(clipId);
      const chatRoomId = await jellyChat.createWishRoom(roomName, [], clipId);

      if (chatRoomId) {
        // Persist roomId in registry
        updateDispatch(clipId, { roomId: chatRoomId });

        // Only send jelly clip on first message to this room
        if (!isExisting) {
          await jellyChat.sendJellyToChat(chatRoomId, clipId);
          log('CHAT', `Sent jelly clip to group "${roomName}"`);
        }

        // Send clean response + help commands
        const helpText = '\n\n💡 Reply here to follow up. Type "stop" or "cancel" to halt a running request.';
        await jellyChat.sendChatMessage(chatRoomId, chatMsg + helpText);
        log('CHAT', `Posted receipt to group "${roomName}"`);

        // Monitor for replies — if user replies in this chat, dispatch as follow-up
        monitorRoomForReplies(jellyChat, chatRoomId, roomName, clipTitle, clipId);

        // Seed conversation history with the initial result
        const state = monitoredRooms.get(chatRoomId);
        if (state && result) {
          state.history.push({ role: 'assistant', content: result });
        }
      }
    }
  } catch (err) {
    log('CHAT', `JellyJelly chat failed (non-fatal): ${err.message}`);
  }
}

// ─── Reply monitoring: process user messages in Jelly group chats ───────────

const monitoredRooms = new Map(); // roomId → { history, clipTitle, processing }

function monitorRoomForReplies(jellyChat, roomId, roomName, clipTitle, clipId) {
  if (monitoredRooms.has(roomId)) return;

  const roomState = {
    clipTitle,
    clipId,
    processing: false,
    history: [], // {role, content} pairs for conversation context
  };
  monitoredRooms.set(roomId, roomState);

  log('CHAT', `Monitoring "${roomName}" for replies...`);

  jellyChat.monitorChat(roomId, async (evt) => {
    try {
      const msg = evt.data || evt;
      const content = (msg.content || '').trim();
      const contentType = msg.content_type || 'text';
      const isFromSelf = evt._isFromSelf === true;

      // Only process text messages from the user (not from Genie bot)
      if (contentType !== 'text' || !content) return;
      if (!isFromSelf) return;

      // Guard against feedback loop: skip messages that are clearly Genie's own output
      // (error receipts, status updates). These patterns mark bot-sent messages.
      const GENIE_PREFIXES = ['🧞', '❌ Genie', '❌ All free models', '⏰ Genie', '✅', '🛑'];
      if (GENIE_PREFIXES.some(p => content.startsWith(p))) {
        log('CHAT', `Skipping Genie self-message in "${roomName}": "${content.slice(0, 80)}"`);
        return;
      }

      if (roomState.processing) {
        log('CHAT', `Already processing in "${roomName}", skipping`);
        return;
      }

      log('CHAT', `Reply from user in "${roomName}": "${content.slice(0, 100)}"`);

      // Cancel support: user types "stop" or "cancel"
      const lowerContent = content.toLowerCase().trim();
      if (lowerContent === 'stop' || lowerContent === 'cancel') {
        const cancelled = cancelDispatch(roomState.clipId);
        const cancelMsg = cancelled
          ? `🛑 Cancelled dispatch for "${roomState.clipTitle}".`
          : `No running dispatch found for "${roomState.clipTitle}".`;
        await jellyChat.sendChatMessage(roomId, cancelMsg);
        await sendMessage(cancelMsg, { plain: true });
        return;
      }

      roomState.history.push({ role: 'user', content });
      roomState.processing = true;

      try {
        // Build conversation context
        const historyContext = roomState.history
          .map(h => `${h.role === 'user' ? 'User' : 'Genie'}: ${h.content}`)
          .join('\n\n');

        const followUpTranscript = [
          `Original wish from jelly "${clipTitle}".`,
          ``,
          `Conversation so far:`,
          historyContext,
          ``,
          `Respond to the user's latest message above.`,
        ].join('\n');

        const followUpResult = await dispatchToClaude({
          transcript: followUpTranscript,
          clipTitle: `Re: ${clipTitle}`,
          creator: 'iqram',
          clipId: `chat-${roomId}`,
          keyword: 'reply',
        });

        const replyText = followUpResult.result || '(no response)';
        roomState.history.push({ role: 'assistant', content: replyText });

        const costStr = `$${(followUpResult.usdCost ?? 0).toFixed(3)}`;
        const durationStr = `${(followUpResult.durationMs / 1000).toFixed(1)}s`;
        // Telegram gets technical detail, Jelly chat gets clean response
        const telegramReply = followUpResult.success && followUpResult.result
          ? `🧞 ${followUpResult.result}\n\n✅ ${costStr} · ${durationStr}`
          : `❌ ${followUpResult.error || 'unknown error'}`;
        const chatReply = followUpResult.success && followUpResult.result
          ? `🧞 ${followUpResult.result.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/^[-•]\s*/gm, '  • ').trim()}`
          : `😔 Something went wrong — ${followUpResult.error || 'unknown error'}`;

        await sendMessage(telegramReply, { plain: true });
        await jellyChat.sendChatMessage(roomId, chatReply);
        log('CHAT', `Replied in "${roomName}"`);
      } finally {
        roomState.processing = false;
      }
    } catch (err) {
      log('CHAT', `Reply handler error: ${err.message}`);
      roomState.processing = false;
    }
  });
}

// ─── Timeout sweeper: auto-kill dispatches running > 60 min ─────────────────
setInterval(() => {
  const running = getRunningDispatches();
  const now = Date.now();
  for (const entry of running) {
    if (!entry.startedAt) continue;
    const elapsed = now - new Date(entry.startedAt).getTime();
    if (elapsed > 60 * 60 * 1000) {
      log('SWEEP', `Auto-killing stale dispatch "${entry.clipTitle}" (${(elapsed / 60000).toFixed(0)}min)`);
      cancelDispatch(entry.clipId);
      sendMessage(`⏰ Auto-cancelled stale dispatch "${entry.clipTitle}" after 60min`, { plain: true }).catch(() => {});
    }
  }
}, 5 * 60 * 1000);
