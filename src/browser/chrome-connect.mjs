#!/usr/bin/env node
// Chrome Connect — Launches ONE persistent Chrome window for Genie to control
// You log in once, it stays open, Genie uses it via CDP
//
// Usage:
//   node src/browser/chrome-connect.mjs launch   # Launch the Genie Chrome (do this once)
//   node src/browser/chrome-connect.mjs post-tweet "text here"
//   node src/browser/chrome-connect.mjs order-uber-eats "pizza"
//   node src/browser/chrome-connect.mjs navigate "https://..."

import { chromium } from 'playwright';
import { spawn, execSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

const PROFILE_DIR = resolve(process.env.HOME, '.genie-live-chrome');
const DEBUG_PORT = 9222;
const DEBUG_URL = `http://127.0.0.1:${DEBUG_PORT}/json/version`;

function log(step, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [GENIE-CHROME] [${step}] ${msg}`);
}

// ─── Check if Genie Chrome is already running ────────────────────────────────
async function isChromeRunning() {
  try {
    const res = await fetch(DEBUG_URL);
    if (res.ok) {
      const data = await res.json();
      return data.Browser;
    }
  } catch (e) {}
  return null;
}

// ─── Launch Chrome with debug port ────────────────────────────────────────────
async function launchChrome() {
  log('LAUNCH', 'Checking if Genie Chrome is already running...');
  const existing = await isChromeRunning();
  if (existing) {
    log('LAUNCH', `Already running: ${existing}`);
    return;
  }

  mkdirSync(PROFILE_DIR, { recursive: true });

  log('LAUNCH', `Starting Chrome with profile: ${PROFILE_DIR}`);
  log('LAUNCH', `Debug port: ${DEBUG_PORT}`);

  const chrome = spawn(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=InfiniteSessionRestore',
    ],
    {
      detached: true,
      stdio: 'ignore',
    }
  );
  chrome.unref();

  // Wait for Chrome to be ready
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    const running = await isChromeRunning();
    if (running) {
      log('LAUNCH', `✅ Chrome is ready: ${running}`);
      log('LAUNCH', '');
      log('LAUNCH', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      log('LAUNCH', 'A Chrome window just opened.');
      log('LAUNCH', 'Log into: X.com, UberEats.com, Gmail, LinkedIn');
      log('LAUNCH', 'LEAVE THIS WINDOW OPEN for the whole demo.');
      log('LAUNCH', 'Genie will use this Chrome to do things.');
      log('LAUNCH', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      return;
    }
  }
  throw new Error('Chrome failed to start with debug port');
}

// ─── Connect to running Chrome ────────────────────────────────────────────────
async function getBrowser() {
  const running = await isChromeRunning();
  if (!running) {
    throw new Error('Genie Chrome is not running. Start it with: node src/browser/chrome-connect.mjs launch');
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  return browser;
}

// ─── Get a page — reuse existing or create new ────────────────────────────────
async function getPage(browser, url = null) {
  const contexts = browser.contexts();
  const context = contexts[0];
  // Use existing page if available, otherwise new
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  }
  return page;
}

// ─── Post a tweet ─────────────────────────────────────────────────────────────
export async function postTweet(text) {
  log('TWEET', `Posting: "${text.slice(0, 60)}..."`);
  const browser = await getBrowser();
  const page = await getPage(browser, 'https://x.com/compose/post');

  // Wait for compose box
  const compose = page.locator('div[data-testid="tweetTextarea_0"]').first();
  await compose.waitFor({ state: 'visible', timeout: 10000 });
  await compose.click();
  await page.keyboard.type(text, { delay: 20 });
  await page.waitForTimeout(800);

  // Click Post button
  const postBtn = page.locator('button[data-testid="tweetButton"]').first();
  await postBtn.click();
  await page.waitForTimeout(3000);

  mkdirSync('/tmp/genie/screenshots', { recursive: true });
  const ssPath = `/tmp/genie/screenshots/tweet-${Date.now()}.png`;
  await page.screenshot({ path: ssPath });

  log('TWEET', '✅ Posted');
  await browser.close(); // disconnect, doesn't close Chrome
  return { status: 'posted', text, screenshot: ssPath };
}

// ─── Navigate to any URL ──────────────────────────────────────────────────────
export async function navigateTo(url) {
  log('NAV', url);
  const browser = await getBrowser();
  const page = await getPage(browser, url);
  await page.waitForTimeout(2000);
  mkdirSync('/tmp/genie/screenshots', { recursive: true });
  const ssPath = `/tmp/genie/screenshots/nav-${Date.now()}.png`;
  await page.screenshot({ path: ssPath });
  log('NAV', `✅ ${await page.title()}`);
  await browser.close();
  return { url, title: await page.title(), screenshot: ssPath };
}

// ─── Order Uber Eats ──────────────────────────────────────────────────────────
export async function orderUberEats(query) {
  log('UBER', `Ordering: ${query}`);
  const browser = await getBrowser();
  const page = await getPage(browser, 'https://www.ubereats.com/');
  await page.waitForTimeout(3000);

  mkdirSync('/tmp/genie/screenshots', { recursive: true });
  let ss = `/tmp/genie/screenshots/uber-01-home-${Date.now()}.png`;
  await page.screenshot({ path: ss });

  // Search for food
  const searchSelectors = [
    'input[placeholder*="Search"]',
    'input[type="search"]',
    'input[aria-label*="search" i]',
  ];
  for (const sel of searchSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        await el.fill(query);
        await page.keyboard.press('Enter');
        log('UBER', 'Searched');
        break;
      }
    } catch (e) {}
  }
  await page.waitForTimeout(3000);
  ss = `/tmp/genie/screenshots/uber-02-search-${Date.now()}.png`;
  await page.screenshot({ path: ss });

  log('UBER', '🔶 Stopped at search results for manual verification');
  await browser.close();
  return { status: 'searched', query, screenshot: ss };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
const cmd = process.argv[2];
const arg = process.argv.slice(3).join(' ');

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('chrome-connect.mjs')) {
  try {
    if (cmd === 'launch') {
      await launchChrome();
    } else if (cmd === 'status') {
      const running = await isChromeRunning();
      console.log(running ? `Running: ${running}` : 'Not running');
    } else if (cmd === 'post-tweet') {
      if (!arg) { console.error('Usage: post-tweet "text"'); process.exit(1); }
      const r = await postTweet(arg);
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === 'navigate') {
      if (!arg) { console.error('Usage: navigate <url>'); process.exit(1); }
      const r = await navigateTo(arg);
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === 'order-uber-eats') {
      if (!arg) { console.error('Usage: order-uber-eats "pizza"'); process.exit(1); }
      const r = await orderUberEats(arg);
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log('Commands:');
      console.log('  launch          - Launch Genie Chrome (do this once)');
      console.log('  status          - Check if running');
      console.log('  post-tweet "X"  - Post a tweet');
      console.log('  navigate <url>  - Navigate to URL');
      console.log('  order-uber-eats "query" - Search Uber Eats');
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
