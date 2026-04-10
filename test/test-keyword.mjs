#!/usr/bin/env node
// Test: Keyword detection — mock data and live clip verification
// Usage: node test/test-keyword.mjs

import { containsKeyword, fetchClipDetail } from '../src/core/firehose.mjs';

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

// Helper: build a mock transcript_overlay from a word list
function mockOverlay(words) {
  return {
    results: {
      channels: [{
        alternatives: [{
          words: words.map(w => ({
            word: w.toLowerCase().replace(/[.,!?]+$/g, ''),
            punctuated_word: w,
          })),
        }],
      }],
    },
  };
}

async function run() {
  console.log('=== Keyword Detection Test Suite ===\n');

  // ─── Test 1: Mock data WITH "genie" ───────────────────────────────────────
  console.log('[1] Mock transcript containing "genie"...');
  const overlayWith = mockOverlay([
    'Hey', 'Genie,', 'book', 'me', 'a', 'Tesla', 'test', 'drive.'
  ]);
  const result1 = containsKeyword(overlayWith, 'genie');
  console.log(`    Result: ${result1}`);
  check('Detects "genie" in mock data (punctuated_word "Genie,")', result1 === true);

  // ─── Test 2: Mock data WITHOUT "genie" ────────────────────────────────────
  console.log('\n[2] Mock transcript NOT containing "genie"...');
  const overlayWithout = mockOverlay([
    'I', 'want', 'to', 'book', 'a', 'Tesla', 'test', 'drive', 'please.'
  ]);
  const result2 = containsKeyword(overlayWithout, 'genie');
  console.log(`    Result: ${result2}`);
  check('Does NOT detect "genie" when absent', result2 === false);

  // ─── Test 3: Edge cases ───────────────────────────────────────────────────
  console.log('\n[3] Edge cases...');
  check('Returns false for null overlay', containsKeyword(null, 'genie') === false);
  check('Returns false for empty keyword', containsKeyword(overlayWith, '') === false);
  check('Returns false for undefined overlay', containsKeyword(undefined, 'genie') === false);
  check('Case insensitive: "GENIE"', containsKeyword(overlayWith, 'GENIE') === true);
  check('Case insensitive: "Genie"', containsKeyword(overlayWith, 'Genie') === true);

  // ─── Test 4: Real clip from JellyJelly API ───────────────────────────────
  console.log(`\n[4] Live test with real clip ${KNOWN_CLIP_ID}...`);
  try {
    const detail = await fetchClipDetail(KNOWN_CLIP_ID);
    const result4 = containsKeyword(detail.transcript_overlay, 'genie');
    console.log(`    Result: ${result4}`);
    check('Detects "genie" in real clip transcript', result4 === true);
  } catch (err) {
    console.log(`    ERROR: ${err.message}`);
    check('Live API reachable for keyword test', false);
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
