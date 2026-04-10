#!/usr/bin/env node
// Test: Telegram bot — send a test message and a mock report, verify delivery

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually
function loadEnv() {
  try {
    const envPath = resolve(__dirname, '..', '.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch (err) {
    console.error('[ENV] Could not load .env:', err.message);
  }
}

loadEnv();

// Now import telegram (after env is loaded)
const { sendMessage, sendReport } = await import('../src/core/telegram.mjs');

let passed = 0;
let failed = 0;

function test(name, ok) {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}`);
    failed++;
  }
}

console.log('\n=== Telegram Bot Tests ===\n');

// Test 1: Send a test message
console.log('1. Sending test message...');
const msgResult = await sendMessage('\u{1F9DE} Genie test \u2014 if you see this, Telegram is working!');
test('sendMessage returns ok', msgResult?.ok === true);

// Test 2: Send a mock report
console.log('2. Sending mock report...');
const reportResult = await sendReport({
  clipTitle: 'Test Clip: User says Genie build me a site',
  results: [
    { description: 'Build landing page for CoolStartup', time: 4.2, status: 'done' },
    { description: 'Deploy to Vercel', time: 2.1, status: 'done' },
    { description: 'Book Tesla Cybertruck test drive', time: 12.5, status: 'done' },
    { description: 'Post on Twitter', time: 0, status: 'skipped' },
  ],
  strategy: 'Build fast, deploy immediately, book the test drive while site compiles',
  totalTime: 18.8,
});
test('sendReport returns ok', reportResult?.ok === true);

// Summary
console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  console.log('FAIL');
  process.exit(1);
} else {
  console.log('PASS');
}
