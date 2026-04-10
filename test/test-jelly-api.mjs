#!/usr/bin/env node
// Test: JellyJelly API — search + detail + transcript extraction
// Usage: node test/test-jelly-api.mjs

import {
  pollForNewClips,
  fetchClipDetail,
  reconstructTranscript,
  containsKeyword,
} from '../src/core/firehose.mjs';

const KNOWN_CLIP_ID = '01KNCQCCNFH3TW1J6D9HBFZZJN';
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    failed++;
  }
}

async function run() {
  console.log('=== JellyJelly API Test Suite ===\n');

  // ─── Test 1: Search endpoint ────────────────────────────────────────────────
  console.log('[1] Fetching search results (page 1, 5 clips)...');
  try {
    const { clips, cursor } = await pollForNewClips({ pageSize: 5 });
    console.log(`    Returned ${clips.length} clips, cursor: ${cursor || 'null'}`);
    check('Search returns an array', Array.isArray(clips));
    check('Search returns at least 1 clip', clips.length > 0);
    if (clips.length > 0) {
      const first = clips[0];
      console.log(`    First clip ID: ${first.id || first.ulid || 'unknown'}`);
      check('First clip has an id', !!(first.id || first.ulid));
    }
  } catch (err) {
    console.log(`    ERROR: ${err.message}`);
    check('Search endpoint is reachable', false);
  }

  // ─── Test 2: Detail endpoint for known clip ────────────────────────────────
  console.log(`\n[2] Fetching detail for known clip ${KNOWN_CLIP_ID}...`);
  try {
    const detail = await fetchClipDetail(KNOWN_CLIP_ID);
    check('Detail returns an object', typeof detail === 'object' && detail !== null);
    check('Detail has id matching request', (detail.id || detail.ulid) === KNOWN_CLIP_ID);
    check('Detail has transcript_overlay', !!detail.transcript_overlay);

    // ─── Test 3: Transcript reconstruction ──────────────────────────────────
    console.log('\n[3] Reconstructing transcript...');
    const transcript = detail._transcript || reconstructTranscript(detail.transcript_overlay);
    console.log(`    Transcript (${transcript.length} chars):`);
    console.log(`    "${transcript.slice(0, 200)}${transcript.length > 200 ? '...' : ''}"`);
    check('Transcript is non-empty', transcript.length > 0);
    check('Transcript contains words', transcript.split(' ').length > 1);

    // ─── Test 4: Keyword detection on real clip ─────────────────────────────
    console.log('\n[4] Checking keyword "genie" in known clip...');
    const found = containsKeyword(detail.transcript_overlay, 'genie');
    console.log(`    Keyword "genie" found: ${found}`);
    check('"genie" keyword detected in known clip', found === true);
  } catch (err) {
    console.log(`    ERROR: ${err.message}`);
    check('Detail endpoint is reachable', false);
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
