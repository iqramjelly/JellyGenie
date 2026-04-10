#!/usr/bin/env node
// Smoke test for the Genie dispatcher.
// Calls dispatchToClaude() with a fake transcript and watches it end-to-end.
// Usage: node test/test-dispatcher.mjs

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');

try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
  console.log(`[TEST] Loaded .env from ${envPath}`);
} catch (err) {
  console.log(`[TEST] No .env at ${envPath}: ${err.message}`);
}

const { dispatchToClaude } = await import('../src/core/dispatcher.mjs');

const fakeTranscript = `Hey genie, look up what's happening at Betaworks in New York in April 2026 — especially the MischiefClaw hackathon — and build me a clean one-page site about it with real details you find on the web. Make it look sharp. Deploy it to Vercel and send me the public URL on Telegram.`;

console.log('[TEST] Invoking dispatchToClaude with fake transcript…');
console.log('[TEST] Transcript:', fakeTranscript);

const result = await dispatchToClaude({
  transcript: fakeTranscript,
  clipTitle: 'Smoke Test — Betaworks April 2026',
  creator: 'test_user',
  clipId: 'test-' + Date.now(),
  keyword: 'genie',
});

console.log('\n[TEST] ============ RESULT ============');
console.log(JSON.stringify({
  success: result.success,
  sessionId: result.sessionId,
  turns: result.turns,
  usdCost: result.usdCost,
  durationMs: result.durationMs,
  exitCode: result.exitCode,
  error: result.error,
  resultPreview: (result.result || '').slice(0, 400),
}, null, 2));

process.exit(result.success ? 0 : 1);
