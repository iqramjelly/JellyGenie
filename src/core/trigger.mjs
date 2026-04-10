#!/usr/bin/env node
// Genie Manual Trigger — Process a specific clip by ID (bypass polling)
// Usage: node src/core/trigger.mjs <clip-id>
// Fallback for when polling is flaky or for testing specific clips

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchClipDetail, reconstructTranscript } from './firehose.mjs';
import { interpretTranscript } from './interpreter.mjs';

// ── Load .env manually (no dotenv dependency) ───────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '..', '.env');

try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  console.log('[TRIGGER] Loaded .env');
} catch (err) {
  console.warn(`[TRIGGER] Could not load .env: ${err.message}`);
}

// ── Main ─────────────────────────────────────────────────────────────
const clipId = process.argv[2];
if (!clipId) {
  console.error('Usage: node src/core/trigger.mjs <clip-id>');
  process.exit(1);
}

console.log(`[TRIGGER] Processing clip: ${clipId}`);
console.log('─'.repeat(60));

try {
  // 1. Fetch clip detail
  console.log('[TRIGGER] Fetching clip from JellyJelly...');
  const clip = await fetchClipDetail(clipId);

  const transcript = clip._transcript || '';
  const creator = {
    username: clip.user?.username || clip.username || 'unknown',
    displayName: clip.user?.display_name || clip.user?.displayName || '',
    bio: clip.user?.bio || '',
  };

  console.log(`[TRIGGER] Creator: @${creator.username}`);
  console.log(`[TRIGGER] Transcript (${transcript.length} chars):`);
  console.log(`  "${transcript.slice(0, 200)}${transcript.length > 200 ? '...' : ''}"`);
  console.log('─'.repeat(60));

  if (!transcript) {
    console.log('[TRIGGER] No transcript found. Exiting.');
    process.exit(0);
  }

  // 2. Interpret transcript
  console.log('[TRIGGER] Interpreting transcript...');
  const proposal = await interpretTranscript(transcript, creator);

  console.log('\n[TRIGGER] === PROPOSAL ===');
  console.log(JSON.stringify(proposal, null, 2));
  console.log('─'.repeat(60));

  // 3. Execute ALL wishes through the full executor (Telegram + browser + deploy)
  console.log(`[TRIGGER] Found ${proposal.wishes.length} wish(es). Executing through full pipeline...`);

  const { executeProposal } = await import('./executor.mjs');
  const result = await executeProposal(proposal, {
    clipTitle: clip.title || `Clip ${clipId}`,
    creator: creator.username,
  });

  console.log(`\n[TRIGGER] Done. ${result.results.length} wishes processed in ${result.totalTime.toFixed(1)}s`);
} catch (err) {
  console.error(`[TRIGGER] Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}
