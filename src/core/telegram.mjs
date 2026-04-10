#!/usr/bin/env node
// Telegram Reporter
// Sends one-way reports to user via Telegram bot
// Supports: text messages, photos (screenshots), step-by-step progress
// Exports: sendMessage(text), sendPhoto(path, caption), sendReport(report)

import { readFileSync } from 'fs';
import { basename } from 'path';

const BOT_TOKEN = () => {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN is not set — add it to .env');
  return t;
};
const CHAT_ID = () => {
  const c = process.env.TELEGRAM_CHAT_ID;
  if (!c) throw new Error('TELEGRAM_CHAT_ID is not set — add it to .env');
  return c;
};
const API_BASE = () => `https://api.telegram.org/bot${BOT_TOKEN()}`;

function log(msg) {
  console.log(`[GENIE] [TELEGRAM] ${msg}`);
}

/**
 * Send a plain text message to Telegram.
 * @param {string} text - Message text (supports Markdown)
 * @returns {Promise<object>} Telegram API response
 */
let rateLimitedUntil = 0;

export async function sendMessage(text, options = {}) {
  // Respect rate limit — don't spam while banned
  if (Date.now() < rateLimitedUntil) {
    return { ok: false, error: 'rate limited' };
  }

  const url = `${API_BASE()}/sendMessage`;
  const { plain = false } = options;

  try {
    const body = {
      chat_id: CHAT_ID(),
      text,
      disable_web_page_preview: true,
    };
    if (!plain) body.parse_mode = 'Markdown';

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!data.ok) {
      // Handle rate limiting
      if (data.parameters?.retry_after) {
        const retryAfter = data.parameters.retry_after;
        rateLimitedUntil = Date.now() + retryAfter * 1000;
        log(`Rate limited for ${retryAfter}s (until ${new Date(rateLimitedUntil).toISOString()})`);
      } else {
        log(`Error: ${data.description || JSON.stringify(data)}`);
      }
      return { ok: false, error: data.description };
    }

    log(`Message sent (${text.length} chars)`);
    return data;
  } catch (err) {
    log(`Failed to send message: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Send a photo with optional caption to Telegram.
 * Uses multipart/form-data with native Node.js APIs (File/Blob).
 * @param {string} photoPath - Absolute path to the image file
 * @param {string} [caption] - Optional caption text
 * @returns {Promise<object>} Telegram API response
 */
export async function sendPhoto(photoPath, caption = '') {
  const url = `${API_BASE()}/sendPhoto`;

  try {
    const fileBuffer = readFileSync(photoPath);
    const fileName = basename(photoPath);

    // Use native FormData + Blob (Node 25)
    const formData = new FormData();
    formData.append('chat_id', CHAT_ID());
    formData.append('photo', new Blob([fileBuffer], { type: 'image/png' }), fileName);
    if (caption) {
      formData.append('caption', caption);
      formData.append('parse_mode', 'Markdown');
    }

    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();

    if (!data.ok) {
      log(`Photo error: ${data.description || JSON.stringify(data)}`);
      return { ok: false, error: data.description };
    }

    log(`Photo sent: ${fileName}`);
    return data;
  } catch (err) {
    log(`Failed to send photo: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Format and send a full wish fulfillment report.
 * @param {object} report
 * @param {string} report.clipTitle - The clip that triggered Genie
 * @param {Array<{description: string, time: number, status: string}>} report.results - Wish results
 * @param {string} [report.strategy] - Strategy recommendation from interpreter
 * @param {number} report.totalTime - Total execution time in seconds
 * @returns {Promise<object>} Telegram API response
 */
export async function sendReport(report) {
  const { clipTitle, results = [], strategy, totalTime } = report;

  let msg = `\u{1F9DE} GENIE REPORT\n`;
  msg += `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n`;
  msg += `Heard you in: "${clipTitle || 'unknown'}"\n\n`;

  for (const r of results) {
    const icon = r.status === 'done' || r.status === 'success' ? '\u2713' : r.status === 'skipped' ? '\u2796' : '\u2717';
    const timeStr = typeof r.time === 'number' ? ` (${r.time.toFixed(1)}s)` : '';
    msg += `${icon} ${r.description}${timeStr}\n`;
  }

  if (strategy) {
    if (typeof strategy === 'object' && strategy.recommendation) {
      msg += `\n💡 Strategy: ${strategy.recommendation}\n`;
    } else if (typeof strategy === 'string') {
      msg += `\n💡 Strategy: ${strategy}\n`;
    }
  }

  const totalStr = typeof totalTime === 'number' ? totalTime.toFixed(1) : '?';
  msg += `\n\u2014 Genie (${totalStr}s total)`;

  return sendMessage(msg);
}
