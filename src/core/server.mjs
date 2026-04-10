#!/usr/bin/env node
// Genie Server — Continuous JellyJelly firehose watcher
// Polls for new clips, detects "genie" keyword, interprets, executes, reports
// Usage: node src/core/server.mjs

import { readFileSync } from 'fs';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Load .env manually ───────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../.env');

try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes first
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: strip inline comments (whitespace + # ...) but not # inside values like JWTs
      const commentMatch = value.match(/\s+#\s/);
      if (commentMatch) value = value.slice(0, commentMatch.index).trim();
    }
    // Don't override existing env vars
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
  log('INIT', `Loaded .env from ${envPath}`);
} catch (err) {
  log('INIT', `.env not found at ${envPath} — using existing env vars`);
}

// ─── Imports (after env is loaded) ────────────────────────────────────────────
import {
  pollForNewClips,
  fetchClipDetail,
  containsKeyword,
  reconstructTranscript,
  transcriptWordCount,
} from './firehose.mjs';
import { sendMessage } from './telegram.mjs';
import { dispatchToClaude } from './dispatcher.mjs';
import { isDispatched, getAllClipRooms } from './dispatch-registry.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────
const POLL_INTERVAL = parseInt(process.env.GENIE_POLL_INTERVAL || '3000', 10);
const FAST_RETRY_INTERVAL = parseInt(process.env.GENIE_FAST_RETRY_INTERVAL || '1500', 10);
const FAST_RETRY_MAX_MS = parseInt(process.env.GENIE_FAST_RETRY_MAX_MS || '300000', 10); // 5 min — transcripts always arrive
const KEYWORD = (process.env.GENIE_KEYWORD || 'genie').toLowerCase();
const MAX_CLIP_AGE_MS = parseInt(process.env.GENIE_MAX_CLIP_AGE_MS || String(30 * 60 * 1000), 10); // 30 min

// Track clip state: Map<clipId, { firstSeenAt: number, dispatched: boolean }>
// A clip is "done" (won't be reprocessed) when:
//   1. It was dispatched (keyword found), OR
//   2. It has both a title and transcript (confirmed no keyword), OR
//   3. 5 minutes have passed since firstSeenAt (assume silent/no transcript)
const CLIP_GRACE_MS = 5 * 60 * 1000; // 5 minutes
const clipState = new Map();
// Clips currently being watched for transcript arrival (don't double-process from main loop)
const awaitingTranscript = new Set();

function isClipDone(clipId) {
  const state = clipState.get(clipId);
  if (!state) return false;
  if (state.dispatched) return true;
  if (state.hasTitle && state.hasTranscript) return true;
  if (Date.now() - state.firstSeenAt >= CLIP_GRACE_MS) return true;
  return false;
}

function markClipSeen(clipId, { hasTitle = false, hasTranscript = false, dispatched = false, title = '' } = {}) {
  const existing = clipState.get(clipId);
  if (existing) {
    if (hasTitle) existing.hasTitle = true;
    if (hasTranscript) existing.hasTranscript = true;
    if (dispatched) existing.dispatched = true;
    if (title) existing.title = title;
  } else {
    clipState.set(clipId, { firstSeenAt: Date.now(), hasTitle, hasTranscript, dispatched, title });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [GENIE] [${tag}] ${msg}`);
}

// ─── Concurrent dispatch ─────────────────────────────────────────────────────
const MAX_CONCURRENT = parseInt(process.env.GENIE_MAX_CONCURRENT || '5', 10);
let activeDispatches = 0;
const wishQueue = []; // overflow queue when at capacity

function drainQueue() {
  while (wishQueue.length > 0 && activeDispatches < MAX_CONCURRENT) {
    const next = wishQueue.shift();
    runDispatch(next);
  }
}

function titleFromTranscript(transcript) {
  if (!transcript) return null;
  // Take first ~8 words, capitalize first letter
  const words = transcript.replace(/[.,!?;:]+/g, '').trim().split(/\s+/).slice(0, 8);
  if (words.length === 0) return null;
  const title = words.join(' ');
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function runDispatch(clip) {
  activeDispatches++;
  const clipId = clip.id || clip.ulid || 'unknown';
  const creator = clip.participants?.[0]?.username || clip.creator?.username || clip.username || 'unknown';
  const transcript = clip._transcript || reconstructTranscript(clip.transcript_overlay) || '';
  const clipTitle = clip.title || clip.description || titleFromTranscript(transcript) || '(untitled)';

  log('EXEC', `Dispatching "${clipTitle}" (clip ${clipId}) by @${creator} (${activeDispatches}/${MAX_CONCURRENT} active)`);

  dispatchToClaude({ transcript, clipTitle, creator, clipId, keyword: KEYWORD })
    .then(result => {
      log('EXEC', `"${clipTitle}" done: success=${result.success} turns=${result.turns} cost=$${result.usdCost ?? 0} in ${(result.durationMs / 1000).toFixed(1)}s`);
    })
    .catch(err => {
      log('EXEC', `Clip ${clipId} threw: ${err.message}`);
      sendMessage(`\u274C Genie error on "${clipTitle}": ${err.message}`).catch(() => {});
    })
    .finally(() => {
      activeDispatches--;
      drainQueue();
    });
}

async function executeGenieAction(clip) {
  const clipId = clip.id || clip.ulid || 'unknown';
  const creator = clip.participants?.[0]?.username || clip.creator?.username || clip.username || 'unknown';
  const transcript = clip._transcript || reconstructTranscript(clip.transcript_overlay) || '';
  const clipTitle = clip.title || clip.description || titleFromTranscript(transcript) || '(untitled)';

  log('EXEC', `Keyword "${KEYWORD}" detected — "${clipTitle}" (clip ${clipId})`);
  log('EXEC', `  Creator: @${creator}`);
  log('EXEC', `  Transcript: ${transcript.slice(0, 200)}`);

  await sendMessage(`\u{1F9DE} Genie heard "${KEYWORD}" in "${clipTitle}" by @${creator}. Spawning Claude Code…`);

  // Send initial acknowledgment to JellyJelly chat
  try {
    const jellyChat = await import('./jelly-chat.mjs');
    await jellyChat.connectChat();
    const roomName = clipTitle || 'Genie Wish';
    const chatRoomId = await jellyChat.createWishRoom(roomName, [], clipId);
    if (chatRoomId) {
      await jellyChat.sendJellyToChat(chatRoomId, clipId);
      const preview = transcript.length > 200 ? transcript.slice(0, 200) + '...' : transcript;
      await jellyChat.sendChatMessage(chatRoomId,
        `Hey @${creator} 👋 Got your request:\n\n"${preview}"\n\nI'm on it, stay tuned! 🧞`
      );
      log('CHAT', `Sent acknowledgment to "${roomName}"`);
    }
  } catch (err) {
    log('CHAT', `Acknowledgment failed (non-fatal): ${err.message}`);
  }

  if (activeDispatches >= MAX_CONCURRENT) {
    log('QUEUE', `${activeDispatches} wishes active, queuing clip ${clipId}`);
    await sendMessage(`\u23F3 Genie is busy (${activeDispatches} active). "${clipTitle}" queued — it'll run next.`);
    wishQueue.push(clip);
  } else {
    runDispatch(clip);
  }
}

// ─── Clip handling ────────────────────────────────────────────────────────────
// Process a clip detail: check if transcript is ready, match keyword, dispatch.
// Returns true if we reached a terminal state (dispatched OR confirmed no keyword).
// Returns false if transcript still isn't ready and we should retry.
async function processClipDetail(detail, clipId) {
  const wordCount = transcriptWordCount(detail.transcript_overlay);
  const titleStr = detail.title || detail.description || '';
  const hasTitle = !!titleStr;
  const hasTranscript = wordCount > 0;

  // Track what we know so far
  markClipSeen(clipId, { hasTitle, hasTranscript, title: titleStr });

  if (!hasTranscript) {
    return false; // not ready, caller will retry
  }

  // Transcript is ready — check for keyword
  if (containsKeyword(detail.transcript_overlay, KEYWORD)) {
    const detectedTitle = (detail.title || detail.description || '').slice(0, 80) || '(untitled)';
    log('KEYWORD', `🧞 "${KEYWORD}" DETECTED — "${detectedTitle}" (clip ${clipId}, ${wordCount} words)`);
    markClipSeen(clipId, { dispatched: true });
    await executeGenieAction(detail);
  } else {
    const transcript = detail._transcript || '(empty)';
    const preview = transcript.length > 80 ? transcript.slice(0, 80) + '...' : transcript;
    log('KEYWORD', `No "${KEYWORD}" in clip ${clipId} (${wordCount} words) — "${preview}"`);
  }
  return true;
}

// Fast-retry watcher: polls a single clip's detail endpoint every FAST_RETRY_INTERVAL
// until the transcript is populated, then processes immediately. Fires detached —
// the main poll loop keeps running in parallel and skips clips in awaitingTranscript.
async function watchClipForTranscript(clipId, clipMeta = {}) {
  if (awaitingTranscript.has(clipId) || isClipDone(clipId)) return;
  awaitingTranscript.add(clipId);

  const username = clipMeta.username || 'unknown';
  log('WATCH', `Fast-watching clip ${clipId} by ${username} for transcript...`);

  const started = Date.now();
  let retryDelay = FAST_RETRY_INTERVAL; // starts at 1500ms, backs off to 8s
  const BACKOFF_CAP = 8000;
  try {
    while (Date.now() - started < FAST_RETRY_MAX_MS) {
      await new Promise(r => setTimeout(r, retryDelay));
      retryDelay = Math.min(retryDelay * 2, BACKOFF_CAP); // exponential backoff
      try {
        const detail = await fetchClipDetail(clipId);
        const done = await processClipDetail(detail, clipId);
        if (done) {
          const elapsed = ((Date.now() - started) / 1000).toFixed(1);
          const t = clipState.get(clipId)?.title || clipId;
          log('WATCH', `"${t}" (${clipId}) — transcript ready after ${elapsed}s`);
          return;
        }
      } catch (err) {
        log('WATCH', `Fetch failed for ${clipId}: ${err.message}`);
      }
    }
    // Timeout — the 5min grace in isClipDone will handle it
    const t = clipState.get(clipId)?.title || clipId;
    log('WATCH', `"${t}" (${clipId}) — transcript never arrived after ${FAST_RETRY_MAX_MS / 1000}s, giving up`);
  } finally {
    awaitingTranscript.delete(clipId);
  }
}

// ─── Main Poll Loop ───────────────────────────────────────────────────────────
let pollCount = 0;

function statusSummary() {
  const watching = [...awaitingTranscript];
  const pending = [];
  const dispatched = [];
  const done = [];
  for (const [id, s] of clipState) {
    if (s.dispatched) dispatched.push(id);
    else if (s.hasTitle && s.hasTranscript) done.push(id);
    else if (!isClipDone(id)) pending.push(id);
    else done.push(id);
  }
  return { watching, pending, dispatched, done, total: clipState.size };
}

function clipLabel(id) {
  // Try to find title from last poll data
  const s = clipState.get(id);
  return s?.title ? `"${s.title}" (${id.slice(-8)})` : id.slice(-8);
}

async function pollOnce() {
  pollCount++;
  try {
    const { clips } = await pollForNewClips();

    // Filter to clips that aren't done, aren't watched, aren't in registry, and aren't too old
    const now = Date.now();
    const newClips = clips.filter(c => {
      const id = c.id || c.ulid;
      if (!id || isClipDone(id) || awaitingTranscript.has(id)) return false;
      if (isDispatched(id)) { markClipSeen(id, { dispatched: true }); return false; }
      const postedAt = c.posted_at ? new Date(c.posted_at).getTime() : 0;
      if (postedAt && (now - postedAt > MAX_CLIP_AGE_MS)) return false;
      return true;
    });

    // Update titles in clipState from poll data
    for (const c of clips) {
      const id = c.id || c.ulid;
      const title = c.title || c.description || '';
      if (id && title && clipState.has(id)) {
        clipState.get(id).title = title;
      }
    }

    // Build status line
    const s = statusSummary();
    const parts = [`#${pollCount} — ${clips.length} fetched`];
    if (newClips.length > 0) parts.push(`${newClips.length} NEW`);
    if (s.watching.length > 0) parts.push(`${s.watching.length} watching`);
    if (s.pending.length > 0) parts.push(`${s.pending.length} pending`);
    if (s.dispatched.length > 0) parts.push(`${s.dispatched.length} dispatched`);
    parts.push(`${s.done.length} done`);
    log('POLL', parts.join(' | '));

    // Detail lines for active items
    if (s.watching.length > 0) {
      log('POLL', `  ⏳ watching: ${s.watching.map(id => clipLabel(id)).join(', ')}`);
    }
    if (s.pending.length > 0) {
      log('POLL', `  🔍 pending: ${s.pending.map(id => clipLabel(id)).join(', ')}`);
    }
    if (s.dispatched.length > 0) {
      log('POLL', `  🧞 dispatched: ${s.dispatched.map(id => clipLabel(id)).join(', ')}`);
    }

    if (newClips.length === 0) return;

    // Process new clips
    await Promise.allSettled(newClips.map(async (clip) => {
      const clipId = clip.id || clip.ulid;
      const username = clip.participants?.[0]?.username || clip.creator?.username || 'unknown';
      const title = clip.title || clip.description || '(untitled)';
      log('FOUND', `"${title}" (${clipId}) by @${username} [${clip.privacy || '?'}]`);

      try {
        clip._transcript = reconstructTranscript(clip.transcript_overlay);
        const done = await processClipDetail(clip, clipId);
        if (!done) {
          log('WATCH', `"${title}" (${clipId}) — no transcript yet, watching...`);
          watchClipForTranscript(clipId, { username }).catch(err =>
            log('WATCH', `Watcher for ${clipId} crashed: ${err.message}`)
          );
        }
      } catch (err) {
        log('ERROR', `Failed to process clip ${clipId}: ${err.message}`);
      }
    }));
  } catch (err) {
    log('ERROR', `Poll failed: ${err.message}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
  log('INIT', '=== GENIE SERVER STARTING ===');
  log('INIT', `Keyword: "${KEYWORD}"`);
  log('INIT', `Poll interval: ${POLL_INTERVAL}ms`);
  const hasAuth = !!process.env.JELLY_AUTH_TOKEN;
  log('INIT', `Auth: ${hasAuth ? 'authenticated (own jellies — all privacy levels)' : 'none (public search only)'}`);

  await sendMessage(`\u{1F9DE} Genie server started. Watching for "${KEYWORD}" in ALL JellyJelly clips every ${POLL_INTERVAL / 1000}s. Say "Genie" in a video and watch what happens.`);

  // Hydrate clipState from persistent dispatch registry — all previously-dispatched
  // clips are immediately marked done so they won't be reprocessed.
  const knownRooms = getAllClipRooms();
  for (const [cid] of knownRooms) {
    markClipSeen(cid, { dispatched: true, hasTitle: true, hasTranscript: true });
  }
  log('INIT', `Registry: ${knownRooms.size} known clip→room mappings loaded`);

  // Seed clipState: mark ALL existing clips as done so only truly NEW jellies
  // (posted after this startup) get dispatched.
  try {
    const { clips } = await pollForNewClips();
    let doneCount = knownRooms.size;
    for (const c of clips) {
      const id = c.id || c.ulid;
      if (!id) continue;
      // Mark every existing clip as done — we only want new ones
      markClipSeen(id, { dispatched: true, hasTitle: true, hasTranscript: true });
      doneCount++;
    }
    log('INIT', `Seeded ${clips.length} existing clips as done — only new jellies will be dispatched`);
  } catch (err) {
    log('INIT', `Seed poll failed (non-fatal): ${err.message}`);
  }

  // Continuous polling
  setInterval(pollOnce, POLL_INTERVAL);

  // Periodic cleanup: purge clipState entries older than 30 min to prevent memory growth
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    let purged = 0;
    for (const [id, state] of clipState) {
      if (state.firstSeenAt < cutoff) { clipState.delete(id); purged++; }
    }
    if (purged > 0) log('CLEANUP', `Purged ${purged} old clip entries (${clipState.size} remaining)`);
  }, 5 * 60 * 1000);

  // ─── Local HTTP listener for clip push notifications ─────────────────────────
  // Jelly-Claw (or any local tool) can POST to http://localhost:7778/clip/{id}
  // to tell Genie about an unlisted clip that won't appear in search.
  const WEBHOOK_PORT = parseInt(process.env.GENIE_WEBHOOK_PORT || '7778', 10);
  const httpServer = createServer(async (req, res) => {
    const match = req.url?.match(/^\/clip\/([A-Za-z0-9]+)/);
    if (req.method === 'POST' && match) {
      const clipId = match[1];
      log('WEBHOOK', `Received push for clip ${clipId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', clipId }));

      if (isClipDone(clipId) || awaitingTranscript.has(clipId)) {
        log('WEBHOOK', `Clip ${clipId} already done/watched — skipping`);
        return;
      }

      // Fetch and process directly (bypasses search API entirely)
      try {
        const detail = await fetchClipDetail(clipId);
        const title = detail.title || detail.description || '(untitled)';
        log('WEBHOOK', `Fetched clip — "${title}" (${clipId})`);
        const done = await processClipDetail(detail, clipId);
        if (!done) {
          watchClipForTranscript(clipId, {}).catch(err =>
            log('WEBHOOK', `Watcher for ${clipId} crashed: ${err.message}`)
          );
        }
      } catch (err) {
        log('WEBHOOK', `Failed to fetch clip ${clipId}: ${err.message}`);
      }
    } else if (req.method === 'GET' && req.url === '/list-rooms') {
      // List all JellyJelly chat rooms (paginated, returns all pages)
      try {
        const jellyChat = await import('./jelly-chat.mjs').catch(() => null);
        if (!jellyChat) { res.writeHead(500); res.end('jelly-chat not available'); return; }
        await jellyChat.connectChat();
        const allRooms = [];
        for (let page = 1; page <= 100; page++) {
          const rooms = await jellyChat.listRooms(page, 50);
          allRooms.push(...rooms);
          if (rooms.length < 50) break;
        }
        log('WEBHOOK', `Listed ${allRooms.length} chat rooms`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', rooms: allRooms }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
    } else if (req.method === 'POST' && req.url === '/delete-chats') {
      // Respond immediately, leave rooms in background
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', message: 'Leaving genie rooms in background...' }));
      log('WEBHOOK', 'Leaving genie rooms (background)...');
      (async () => {
      let roomsDeleted = 0;
      try {
        const jellyChat = await import('./jelly-chat.mjs').catch(() => null);
        if (jellyChat) {
          await jellyChat.connectChat();
          roomsDeleted = await jellyChat.deleteAllRooms();
        }
      } catch (err) { log('WEBHOOK', `Delete rooms error: ${err.message}`); }
      try {
        const chatHistory = await import('./chat-history.mjs').catch(() => null);
        if (chatHistory) historyCleared = chatHistory.clearHistory();
      } catch (err) { log('WEBHOOK', `Clear history error: ${err.message}`); }
      log('WEBHOOK', `Left ${roomsDeleted} rooms, cleared ${historyCleared.messagesCleared} messages`);
      })();
    } else if (req.method === 'GET' && req.url === '/status') {
      // Return current dispatch status
      try {
        const reg = await import('./dispatch-registry.mjs').catch(() => null);
        const running = reg ? reg.getRunningDispatches() : [];
        const all = reg ? reg.getAllDispatches() : {};
        const total = Object.keys(all).length;
        const done = Object.values(all).filter(e => e.status === 'done').length;
        const cancelled = Object.values(all).filter(e => e.status === 'cancelled').length;
        const errored = Object.values(all).filter(e => e.status === 'error').length;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          activeDispatches,
          running: running.map(e => ({ clipId: e.clipId, title: e.clipTitle, pid: e.pid, startedAt: e.startedAt })),
          stats: { total, done, cancelled, errored },
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
    } else if (req.method === 'POST' && req.url === '/cancel-all') {
      // Cancel all running dispatches
      try {
        const reg = await import('./dispatch-registry.mjs').catch(() => null);
        if (!reg) { res.writeHead(500); res.end('registry unavailable'); return; }
        const running = reg.getRunningDispatches();
        let killed = 0;
        for (const entry of running) {
          if (reg.cancelDispatch(entry.clipId)) killed++;
        }
        log('WEBHOOK', `Cancelled ${killed} running dispatches`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', killed }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
    } else if (req.method === 'POST' && req.url?.startsWith('/cancel/')) {
      // Cancel a specific dispatch by clipId
      const clipId = req.url.slice('/cancel/'.length);
      try {
        const reg = await import('./dispatch-registry.mjs').catch(() => null);
        const cancelled = reg ? reg.cancelDispatch(clipId) : false;
        log('WEBHOOK', `Cancel ${clipId}: ${cancelled}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', cancelled }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('INIT', `Port ${WEBHOOK_PORT} in use — webhook disabled (non-fatal)`);
    } else {
      log('INIT', `Webhook error: ${err.message}`);
    }
  });
  httpServer.listen(WEBHOOK_PORT, '127.0.0.1', () => {
    log('INIT', `Webhook listener on http://127.0.0.1:${WEBHOOK_PORT}/clip/{id}`);
  });

  log('INIT', `Polling every ${POLL_INTERVAL / 1000}s. Ctrl+C to stop.`);
}

main().catch(err => {
  log('FATAL', err.message);
  console.error(err);
  process.exit(1);
});
