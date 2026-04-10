#!/usr/bin/env node
// Test: Transcript interpreter — feed sample transcript, verify proposal JSON

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Load .env manually ──────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');

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
} catch (err) {
  console.error(`Could not load .env: ${err.message}`);
  process.exit(1);
}

// ── Import interpreter ───────────────────────────────────────────────
import { interpretTranscript } from '../src/core/interpreter.mjs';

// ── Test data ────────────────────────────────────────────────────────
const SAMPLE_TRANSCRIPT = `So now I'm at the Beta Works compound. You know? We're doing another Claude bot hackathon, and there's this sick cyber shark outside of it. That's dope. And, you know, I was thinking, I've been here in New York for about a month, and I would really love to do an event where I just show off everything I've done and, like, all the different things we've been building with either startups or just people. I wish there was a genie who can, like, make it all work for me, and, like, help me organize this event. Let me know if you know of anything like that.`;

const SAMPLE_CREATOR = {
  username: 'testuser',
  displayName: 'Test User',
  bio: 'Builder. AI agent architect.',
};

// ── Run test ─────────────────────────────────────────────────────────
console.log('=== TEST: Interpreter ===');
console.log(`Model: ${process.env.OPENROUTER_MODEL || 'default'}`);
console.log(`Transcript: ${SAMPLE_TRANSCRIPT.length} chars`);
console.log('');

let passed = 0;
let failed = 0;

try {
  const proposal = await interpretTranscript(SAMPLE_TRANSCRIPT, SAMPLE_CREATOR);

  console.log('--- PROPOSAL ---');
  console.log(JSON.stringify(proposal, null, 2));
  console.log('');

  // Test 1: Has title
  if (proposal.title && proposal.title.length > 0) {
    console.log('PASS: Has title -', proposal.title);
    passed++;
  } else {
    console.log('FAIL: Missing title');
    failed++;
  }

  // Test 2: Has summary
  if (proposal.summary && proposal.summary.length > 0) {
    console.log('PASS: Has summary');
    passed++;
  } else {
    console.log('FAIL: Missing summary');
    failed++;
  }

  // Test 3: Has at least one wish
  if (proposal.wishes && proposal.wishes.length > 0) {
    console.log(`PASS: Has ${proposal.wishes.length} wish(es)`);
    passed++;
  } else {
    console.log('FAIL: No wishes extracted');
    failed++;
  }

  // Test 4: Each wish has required fields
  let wishesValid = true;
  for (const wish of proposal.wishes || []) {
    if (!wish.type || !wish.title || wish.priority === undefined) {
      console.log(`FAIL: Wish missing fields: ${JSON.stringify(wish)}`);
      wishesValid = false;
      break;
    }
  }
  if (wishesValid && (proposal.wishes || []).length > 0) {
    console.log('PASS: All wishes have type, title, priority');
    passed++;
  } else if ((proposal.wishes || []).length === 0) {
    // Already counted as fail above
  } else {
    failed++;
  }

  // Test 5: Has strategy
  if (proposal.strategy && proposal.strategy.recommendation) {
    console.log('PASS: Has strategy recommendation');
    passed++;
  } else {
    console.log('FAIL: Missing strategy');
    failed++;
  }

  // Test 6: Detected BUILD intent (should find event page / showcase site)
  const hasBuild = (proposal.wishes || []).some(w => w.type === 'BUILD');
  if (hasBuild) {
    console.log('PASS: Detected BUILD wish');
    passed++;
  } else {
    console.log('FAIL: No BUILD wish detected (expected event/showcase site)');
    failed++;
  }

  // Test 7: Valid wish types
  const validTypes = new Set(['BUILD', 'OUTREACH', 'PROMOTE', 'RESEARCH', 'CONNECT', 'BOOK', 'REMIND']);
  const allTypesValid = (proposal.wishes || []).every(w => validTypes.has(w.type));
  if (allTypesValid) {
    console.log('PASS: All wish types are valid');
    passed++;
  } else {
    const badTypes = (proposal.wishes || []).filter(w => !validTypes.has(w.type)).map(w => w.type);
    console.log(`FAIL: Invalid wish types found: ${badTypes.join(', ')}`);
    failed++;
  }

} catch (err) {
  console.error(`FAIL: Interpreter threw error: ${err.message}`);
  console.error(err.stack);
  failed++;
}

console.log('');
console.log(`=== RESULTS: ${passed} passed, ${failed} failed ===`);
console.log(failed === 0 ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
process.exit(failed > 0 ? 1 : 0);
