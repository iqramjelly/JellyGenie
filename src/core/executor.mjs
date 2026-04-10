#!/usr/bin/env node
// Wish Executor
// Takes a structured proposal -> executes each wish in priority order
// Routes to: build-site, deploy, browser actions, email, research
// Exports: executeProposal(proposal)

import { sendMessage, sendPhoto, sendReport } from './telegram.mjs';
import { getUser, addWish, updateUser, getUserSummary } from './memory.mjs';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function log(step, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [GENIE] [EXEC] [${step}] ${msg}`);
}

/**
 * Execute a full proposal — runs each wish in priority order.
 * @param {object} proposal - Structured proposal from interpreter
 * @param {Array<{type: string, priority: number, description: string, params: object}>} proposal.wishes
 * @param {string} [proposal.strategy] - Strategy recommendation
 * @param {object} [options]
 * @param {string} [options.clipTitle] - Title of the clip that triggered this
 * @param {string} [options.creator] - Creator username
 * @returns {Promise<{results: Array, totalTime: number}>}
 */
export async function executeProposal(proposal, options = {}) {
  const { clipTitle = 'unknown', creator = 'unknown' } = options;
  const wishes = Array.isArray(proposal.wishes) ? proposal.wishes : [];

  // Sort by priority (lower number = higher priority)
  const sorted = [...wishes].sort((a, b) => (a.priority || 99) - (b.priority || 99));

  log('START', `Executing ${sorted.length} wishes from "${clipTitle}" (creator: ${creator})`);

  // Memory: greet returning users with their history
  const userHistory = getUser(creator);
  const greeting = getUserSummary(creator);
  if (greeting) {
    await sendMessage(greeting);
  }

  await sendMessage(`\u{1F9DE} Genie activated! Processing ${sorted.length} wish${sorted.length !== 1 ? 'es' : ''} from "${clipTitle}"...`);

  const results = [];
  const t0 = Date.now();

  // Ensure screenshot dir exists
  mkdirSync('/tmp/genie/screenshots', { recursive: true });

  for (let i = 0; i < sorted.length; i++) {
    const wish = sorted[i];
    const wishNum = i + 1;
    const wishLabel = `[${wishNum}/${sorted.length}] ${wish.type}: ${wish.description}`;

    log('WISH', wishLabel);
    await sendMessage(`\u23F3 ${wishLabel}`);

    const wishStart = Date.now();
    let result = { description: wish.description, type: wish.type, status: 'pending', time: 0 };

    try {
      switch (wish.type) {
        case 'BUILD': {
          result = await handleBuild(wish, wishNum);
          break;
        }
        case 'BOOK': {
          result = await handleBook(wish);
          break;
        }
        case 'RESEARCH': {
          result = await handleResearch(wish);
          break;
        }
        case 'OUTREACH': {
          result = await handleOutreach(wish);
          break;
        }
        case 'PROMOTE': {
          result = await handlePromote(wish, results);
          break;
        }
        case 'CONNECT': {
          result = await handleConnect(wish);
          break;
        }
        case 'REMIND': {
          result = await handleRemind(wish);
          break;
        }
        default: {
          log('UNKNOWN', `Type "${wish.type}" not implemented yet`);
          result = {
            description: wish.description,
            type: wish.type,
            status: 'skipped',
            message: `Handler for "${wish.type}" not implemented yet`,
            time: 0,
          };
          break;
        }
      }
    } catch (err) {
      log('ERROR', `Wish failed: ${err.message}`);
      result = {
        description: wish.description,
        type: wish.type,
        status: 'error',
        error: err.message,
        time: 0,
      };
    }

    // Calculate time for this wish
    result.time = (Date.now() - wishStart) / 1000;
    results.push(result);

    const statusIcon = result.status === 'done' || result.status === 'success' ? '\u2705' : result.status === 'skipped' ? '\u23ED' : '\u274C';
    await sendMessage(`${statusIcon} ${wish.description} — ${result.status} (${result.time.toFixed(1)}s)`);

    // Memory: record each fulfilled wish
    try {
      addWish(creator, {
        date: new Date().toISOString(),
        type: wish.type,
        title: wish.description || wish.title || '',
        url: result.url || null,
        clipId: clipTitle || null,
      });
    } catch (memErr) {
      log('MEMORY', `Failed to record wish: ${memErr.message}`);
    }
  }

  const totalTime = (Date.now() - t0) / 1000;

  // Memory: update user lastSeen and send summary
  try {
    updateUser(creator, { lastSeen: new Date().toISOString() });
    const summary = getUserSummary(creator);
    if (summary) {
      await sendMessage(summary);
    }
  } catch (memErr) {
    log('MEMORY', `Failed to update user: ${memErr.message}`);
  }

  // Send final report
  await sendReport({
    clipTitle,
    results,
    strategy: proposal.strategy || null,
    totalTime,
  });

  log('DONE', `All wishes processed in ${totalTime.toFixed(1)}s`);

  return { results, totalTime };
}

/**
 * Handle BUILD wish — build site then deploy to Vercel, take screenshot.
 */
async function handleBuild(wish, wishNum) {
  const spec = wish.spec || wish.params || {};

  // Step 0: Real web research BEFORE building — grounds the site in live facts
  // (dates, prices, addresses, names) instead of the LLM's guesses from the transcript.
  try {
    const { researchTopic } = await import('../scripts/research-topic.mjs');
    const query = [
      spec.name,
      spec.tagline,
      wish.description,
      spec.location,
      spec.date,
    ].filter(Boolean).join(' — ');

    if (query.trim()) {
      await sendMessage(`🔎 [${wishNum}] Researching live facts for "${spec.name || query.slice(0, 60)}"...`);
      const research = await researchTopic(query);

      if (research.facts?.length || research.features?.length) {
        // Merge research into spec — research features take priority (they have real data)
        if (research.features?.length) {
          spec.features = research.features;
        } else if (research.facts?.length) {
          // Fall back to converting facts into feature cards
          spec.features = research.facts.map(f => ({
            title: f.label,
            description: f.value,
          }));
        }
        if (research.summary && !spec.tagline?.includes(research.summary.slice(0, 30))) {
          spec.tagline = research.summary;
        }
        // Stash sources so the builder/template can render citations later
        spec.sources = research.sources || [];

        await sendMessage(`✅ [${wishNum}] Found ${research.facts?.length || 0} facts from ${research.sources?.length || 0} sources`);
      } else {
        log('BUILD', `Research returned nothing usable — using original spec`);
      }
    }
  } catch (err) {
    log('BUILD', `Research step failed (non-fatal): ${err.message}`);
  }

  // Build the site
  let siteDir;
  try {
    const { buildSite } = await import('../scripts/build-site.mjs');
    const buildResult = buildSite(spec);
    siteDir = buildResult.dir;
    log('BUILD', `Site built: ${siteDir}`);
    await sendMessage(`🔨 [${wishNum}] Site generated — deploying to Vercel...`);
  } catch (err) {
    log('BUILD', `Build failed: ${err.message}`);
    return { description: wish.description || wish.title, type: 'BUILD', status: 'error', error: err.message, time: 0 };
  }

  // Deploy to Vercel
  let url;
  let deployTime;
  try {
    const { deployToVercel } = await import('../scripts/deploy-vercel.mjs');
    const slug = (spec.name || `genie-site-${wishNum}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const result = deployToVercel(siteDir, `genie-${slug}`);
    url = result.url;
    deployTime = result.deployTime;
    log('BUILD', `Deployed: ${url} (${(deployTime / 1000).toFixed(1)}s)`);
    await sendMessage(`🚀 [${wishNum}] LIVE: ${url} (${(deployTime / 1000).toFixed(1)}s)`);
  } catch (err) {
    log('BUILD', `Deploy failed: ${err.message}`);
    return { description: wish.description || wish.title, type: 'BUILD', status: 'error', error: err.message, time: 0 };
  }

  // Screenshot the deployed site
  let screenshotPath;
  if (url) {
    try {
      const { takeScreenshot } = await import('../scripts/take-screenshot.mjs');
      const ssPath = `/tmp/genie/screenshots/build-${wishNum}-${Date.now()}.png`;
      const ssResult = await takeScreenshot(url, ssPath);
      screenshotPath = ssResult.path;
      log('BUILD', `Screenshot: ${screenshotPath}`);
      await sendPhoto(screenshotPath, `🌐 ${spec.name || 'Site'} — LIVE at ${url}`);
    } catch (err) {
      log('BUILD', `Screenshot failed: ${err.message}`);
    }
  }

  return {
    description: `${spec.name || wish.title || wish.description} → ${url}`,
    type: 'BUILD',
    status: 'done',
    url,
    screenshot: screenshotPath || null,
    time: 0,
  };
}

/**
 * Handle BOOK wish — currently only Tesla test drive booking.
 */
async function handleBook(wish) {
  const spec = wish.spec || wish.params || {};
  const target = (spec.what || spec.target || wish.description || wish.title || '').toLowerCase();

  if (target.includes('tesla') || target.includes('cybertruck') || target.includes('test drive')) {
    await sendMessage(`🚗 Opening Chrome → tesla.com/drive...\nBooking Cybertruck test drive at Meatpacking Tesla`);
    try {
      const { bookTeslaTestDrive } = await import('../browser/book-tesla.mjs');
      const result = await bookTeslaTestDrive();
      log('BOOK', `Tesla booking result: ${result?.status || 'completed'}`);

      // Send screenshots to Telegram
      if (result?.screenshots) {
        for (const ss of result.screenshots) {
          try { await sendPhoto(ss, '🚗 Tesla booking progress'); } catch (e) {}
        }
      }

      const statusMsg = result?.status === 'booked'
        ? `✅ Tesla Cybertruck test drive BOOKED!\n📍 ${result.location || 'Manhattan / Meatpacking'}\n🔗 Check your email for confirmation`
        : result?.status === 'dry_run'
        ? `🔶 Tesla form filled — browser open for manual submit`
        : `⚠️ Tesla booking completed with status: ${result?.status}`;

      await sendMessage(statusMsg);

      // Also build a confirmation site with maps + details
      await sendMessage(`🔨 Building your test drive confirmation page...`);
      try {
        const { buildSite } = await import('../scripts/build-site.mjs');
        const { deployToVercel } = await import('../scripts/deploy-vercel.mjs');
        const confirmSite = buildSite({
          name: 'Cybertruck Test Drive',
          tagline: 'Your test drive is booked. See you at Tesla Meatpacking.',
          features: [
            'Vehicle: Tesla Cybertruck',
            'Location: Tesla Manhattan — 860 Washington St, Meatpacking District',
            'Status: Confirmed',
          ],
          colors: { primary: '#e31937', accent: '#cc0000' },
          location: 'Tesla Manhattan — 860 Washington St, NYC 10014',
          date: 'Today — check email for exact time',
          ctaText: 'Open in Google Maps',
          creatorName: process.env.JELLYGENIE_OWNER_NAME || 'User',
        });
        const deploy = deployToVercel(confirmSite.dir, 'genie-cybertruck-booking');
        await sendMessage(`🚗 Confirmation page LIVE: ${deploy.url}\n📍 Maps: https://maps.google.com/?q=Tesla+Manhattan+860+Washington+St+NYC`);

        // Screenshot and send
        try {
          const { takeScreenshot } = await import('../scripts/take-screenshot.mjs');
          const ss = await takeScreenshot(deploy.url, `/tmp/genie/screenshots/tesla-confirm-${Date.now()}.png`);
          await sendPhoto(ss.path, `🚗 Your Cybertruck test drive — ${deploy.url}`);
        } catch (e) {}
      } catch (buildErr) {
        log('BOOK', `Confirmation site build failed: ${buildErr.message}`);
      }

      return {
        description: `Tesla Cybertruck test drive → ${result?.status || 'completed'}`,
        type: 'BOOK',
        status: result?.status === 'error' ? 'error' : 'done',
        details: result,
        time: 0,
      };
    } catch (err) {
      log('BOOK', `Tesla booking failed: ${err.message}`);
      await sendMessage(`❌ Tesla booking failed: ${err.message}`);
      return { description: wish.description || wish.title, type: 'BOOK', status: 'error', error: err.message, time: 0 };
    }
  }

  log('BOOK', `Booking target "${target}" not supported yet`);
  await sendMessage(`⏭ Booking "${target}" — not supported yet`);
  return { description: wish.description || wish.title, type: 'BOOK', status: 'skipped', time: 0 };
}

// ──────────────────────────────────────────────────────────────────────
// RESEARCH handler — Apollo.io enrichment or Telegram fallback
// ──────────────────────────────────────────────────────────────────────
async function handleResearch(wish) {
  const spec = wish.spec || wish.params || {};
  const name = spec.name || spec.person || spec.target || wish.description || '';
  const company = spec.company || spec.organization || spec.organization_name || '';

  log('RESEARCH', `Researching: ${name}${company ? ` at ${company}` : ''}`);

  const apolloKey = process.env.APOLLO_API_KEY;

  if (apolloKey) {
    try {
      const body = { name };
      if (company) body.organization_name = company;

      const res = await fetch('https://api.apollo.io/api/v1/people/match', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apolloKey,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`Apollo API ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      const person = data.person || data;

      const title = person.title || 'Unknown title';
      const org = person.organization?.name || company || 'Unknown company';
      const email = person.email || 'not found';
      const linkedin = person.linkedin_url || person.linkedin || 'not found';
      const foundName = person.name || name;

      const msg = `🔍 Research: Found ${foundName}, ${title} at ${org}. Email: ${email}. LinkedIn: ${linkedin}`;
      log('RESEARCH', msg);
      await sendMessage(msg);

      return {
        description: `Research: ${foundName} at ${org}`,
        type: 'RESEARCH',
        status: 'done',
        data: { name: foundName, title, company: org, email, linkedin },
        time: 0,
      };
    } catch (err) {
      log('RESEARCH', `Apollo failed: ${err.message} — falling back to Telegram`);
      await sendMessage(`⚠️ Apollo lookup failed: ${err.message}`);
    }
  }

  // Fallback: send research request to Telegram for manual handling
  const fallbackMsg = `🔍 Research request:\n\nPerson: ${name}${company ? `\nCompany: ${company}` : ''}\n\nDetails: ${wish.description || 'No additional details'}\n\n(No APOLLO_API_KEY set — manual research needed)`;
  await sendMessage(fallbackMsg);

  return {
    description: `Research request: ${name}`,
    type: 'RESEARCH',
    status: 'done',
    message: 'Sent to Telegram (no Apollo key)',
    time: 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// OUTREACH handler — Resend email or Telegram draft
// ──────────────────────────────────────────────────────────────────────
async function handleOutreach(wish) {
  const spec = wish.spec || wish.params || {};
  const to = spec.to || spec.email || spec.target || '';
  const subject = spec.subject || `Reaching out — ${spec.target || spec.name || 'Introduction'}`;
  const message = spec.message || spec.body || spec.html || wish.description || '';
  const targetName = spec.name || spec.target || to || 'recipient';

  log('OUTREACH', `Outreach to ${targetName}: ${subject}`);

  const resendKey = process.env.RESEND_API_KEY;

  if (resendKey && to) {
    try {
      const html = message.includes('<') ? message : `<p>${message.replace(/\n/g, '<br>')}</p>`;

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: 'Genie <genie@resend.dev>',
          to,
          subject,
          html,
        }),
      });

      if (!res.ok) {
        throw new Error(`Resend API ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      const confirmMsg = `📧 Outreach: Email sent to ${targetName} — Subject: ${subject}`;
      log('OUTREACH', confirmMsg);
      await sendMessage(confirmMsg);

      return {
        description: `Outreach to ${targetName}`,
        type: 'OUTREACH',
        status: 'done',
        emailId: data.id,
        time: 0,
      };
    } catch (err) {
      log('OUTREACH', `Resend failed: ${err.message}`);
      await sendMessage(`⚠️ Resend failed: ${err.message} — drafting to Telegram instead`);
    }
  }

  // Fallback: draft to Telegram
  const draftMsg = `📧 Outreach: Draft ready (no Resend key) — copy from Telegram\n\n` +
    `To: ${to || '(no email provided)'}\n` +
    `Subject: ${subject}\n\n` +
    `---\n${message}\n---`;
  await sendMessage(draftMsg);

  return {
    description: `Outreach draft for ${targetName}`,
    type: 'OUTREACH',
    status: 'done',
    message: 'Draft sent to Telegram (no Resend key)',
    time: 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// PROMOTE handler — OpenRouter copy generation + Telegram delivery
// ──────────────────────────────────────────────────────────────────────
async function handlePromote(wish, previousResults = []) {
  const spec = wish.spec || wish.params || {};
  const platform = (spec.platform || spec.channel || 'general').toLowerCase();
  const contentHint = spec.content || spec.topic || spec.hint || wish.description || '';
  const siteUrl = spec.url || '';

  // Look for a URL from a previous BUILD wish in the same proposal
  let buildUrl = siteUrl;
  if (!buildUrl) {
    const buildResult = previousResults.find(r => r.type === 'BUILD' && r.url);
    if (buildResult) buildUrl = buildResult.url;
  }

  log('PROMOTE', `Generating ${platform} copy — hint: ${contentHint}`);

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-6';

  if (!openrouterKey) {
    const fallbackMsg = `📢 Promo request for ${platform}:\n\n${contentHint}${buildUrl ? `\nURL: ${buildUrl}` : ''}\n\n(No OPENROUTER_API_KEY set — write copy manually)`;
    await sendMessage(fallbackMsg);
    return {
      description: `Promo request for ${platform}`,
      type: 'PROMOTE',
      status: 'done',
      message: 'Sent to Telegram (no OpenRouter key)',
      time: 0,
    };
  }

  let platformInstruction;
  switch (platform) {
    case 'twitter':
    case 'x':
      platformInstruction = 'Write a punchy tweet, MUST be under 280 characters. No hashtag spam — max 2. Make it compelling and shareable.';
      break;
    case 'linkedin':
      platformInstruction = 'Write a professional LinkedIn post, 2-3 short paragraphs. Conversational but polished. Include a hook in the first line.';
      break;
    default:
      platformInstruction = 'Write versatile promotional copy that works across platforms. Keep it engaging, 2-4 sentences.';
  }

  const systemPrompt = 'You are a sharp copywriter. Output ONLY the copy — no commentary, no quotes around it, no "Here\'s your copy:" prefix. Just the raw text ready to post.';
  const userPrompt = `${platformInstruction}\n\nTopic/context: ${contentHint}${buildUrl ? `\n\nInclude this URL: ${buildUrl}` : ''}`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openrouterKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 500,
        temperature: 0.8,
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenRouter API ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const copy = data.choices?.[0]?.message?.content?.trim() || '(empty response)';

    const telegramMsg = `📢 Promo copy for ${platform}:\n\n${copy}\n\nReady to post!`;
    await sendMessage(telegramMsg);

    return {
      description: `Promo copy for ${platform}`,
      type: 'PROMOTE',
      status: 'done',
      copy,
      platform,
      time: 0,
    };
  } catch (err) {
    log('PROMOTE', `OpenRouter failed: ${err.message}`);
    await sendMessage(`⚠️ Copy generation failed: ${err.message}\n\nManual prompt: ${contentHint}`);
    return {
      description: `Promo copy for ${platform}`,
      type: 'PROMOTE',
      status: 'error',
      error: err.message,
      time: 0,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────
// CONNECT handler — warm introduction via Resend or Telegram draft
// ──────────────────────────────────────────────────────────────────────
async function handleConnect(wish) {
  const spec = wish.spec || wish.params || {};
  const to = spec.to || spec.email || '';
  const targetName = spec.name || spec.target || spec.person || to || 'someone';
  const context = spec.context || spec.reason || spec.message || wish.description || '';
  const subject = spec.subject || `Introduction — ${targetName}`;

  log('CONNECT', `Drafting warm intro for ${targetName}`);

  const introHtml = `
    <p>Hi ${targetName.split(' ')[0]},</p>
    <p>I hope this message finds you well. I wanted to reach out and connect — ${context || 'I think we could find interesting ways to collaborate'}.</p>
    <p>Would love to find a time to chat if you're open to it.</p>
    <p>Best,<br>${process.env.JELLYGENIE_OWNER_NAME?.split(' ')[0] || 'User'}</p>
  `.trim();

  const resendKey = process.env.RESEND_API_KEY;

  if (resendKey && to) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: 'Genie <genie@resend.dev>',
          to,
          subject,
          html: introHtml,
        }),
      });

      if (!res.ok) {
        throw new Error(`Resend API ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      const confirmMsg = `🤝 Connect: Introduction drafted for ${targetName} — sent via email`;
      log('CONNECT', confirmMsg);
      await sendMessage(confirmMsg);

      return {
        description: `Introduction to ${targetName}`,
        type: 'CONNECT',
        status: 'done',
        emailId: data.id,
        time: 0,
      };
    } catch (err) {
      log('CONNECT', `Resend failed: ${err.message}`);
      await sendMessage(`⚠️ Resend failed: ${err.message} — drafting to Telegram`);
    }
  }

  // Fallback: send intro draft to Telegram
  const plainIntro = `Hi ${targetName.split(' ')[0]},\n\nI hope this message finds you well. I wanted to reach out and connect — ${context || 'I think we could find interesting ways to collaborate'}.\n\nWould love to find a time to chat if you're open to it.\n\nBest,\n${process.env.JELLYGENIE_OWNER_NAME?.split(' ')[0] || 'User'}`;
  const draftMsg = `🤝 Connect: Introduction drafted for ${targetName}\n\nTo: ${to || '(no email provided)'}\nSubject: ${subject}\n\n---\n${plainIntro}\n---\n\n(No Resend key — copy and send manually)`;
  await sendMessage(draftMsg);

  return {
    description: `Introduction draft for ${targetName}`,
    type: 'CONNECT',
    status: 'done',
    message: 'Draft sent to Telegram',
    time: 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// REMIND handler — store reminder + notify via Telegram
// ──────────────────────────────────────────────────────────────────────
async function handleRemind(wish) {
  const spec = wish.spec || wish.params || {};
  const task = spec.task || spec.what || spec.reminder || wish.description || 'Unnamed reminder';
  const when = spec.when || spec.time || spec.date || 'later';

  log('REMIND', `Reminder: "${task}" — ${when}`);

  // Store reminder in ~/.genie/reminders.json
  const genieDir = join(homedir(), '.genie');
  const remindersFile = join(genieDir, 'reminders.json');

  try {
    mkdirSync(genieDir, { recursive: true });

    let reminders = [];
    if (existsSync(remindersFile)) {
      try {
        reminders = JSON.parse(readFileSync(remindersFile, 'utf-8'));
      } catch { reminders = []; }
    }

    reminders.push({
      id: `rem_${Date.now()}`,
      task,
      when,
      createdAt: new Date().toISOString(),
      status: 'pending',
      source: wish.description || task,
    });

    writeFileSync(remindersFile, JSON.stringify(reminders, null, 2));
    log('REMIND', `Saved to ${remindersFile} (${reminders.length} total)`);
  } catch (err) {
    log('REMIND', `Failed to save reminder: ${err.message}`);
  }

  const confirmMsg = `⏰ Reminder set: ${task} — I'll remind you ${when}`;
  await sendMessage(confirmMsg);

  return {
    description: `Reminder: ${task}`,
    type: 'REMIND',
    status: 'done',
    reminder: { task, when },
    time: 0,
  };
}
