#!/usr/bin/env node
/**
 * chrome-control.mjs — Browser automation for MischiefClaw hackathon demo
 *
 * Connects to the user's REAL Chrome with logged-in sessions.
 * Approach priority:
 *   1. CDP: Connect to running Chrome via DevTools Protocol (port 9222)
 *   2. Relaunch: Quit Chrome, relaunch with --remote-debugging-port, reconnect
 *   3. OpenClaw profile: Launch Playwright with OpenClaw's user-data (has sessions)
 *   4. MCP profile: Launch Playwright with MCP browser profile
 *
 * Exports: getPage(), postTweet(text), orderUberEats(query, address)
 *
 * Usage:
 *   node src/browser/chrome-control.mjs tweet "Hello from MischiefClaw!"
 *   node src/browser/chrome-control.mjs uber "pizza" "10014"
 *   node src/browser/chrome-control.mjs test
 */

import { chromium } from 'playwright';
import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { setTimeout as sleep } from 'timers/promises';

// ============================================================================
// CONFIG
// ============================================================================

const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const SCREENSHOTS_DIR = '/tmp/genie/screenshots';

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_PROFILE = resolve(process.env.HOME, 'Library/Application Support/Google/Chrome');

// Dedicated Chrome profile for Genie automation. The user logs into X/Uber
// ONCE in this profile; sessions persist and CDP works (Chrome refuses CDP
// on the default profile dir — that's the whole reason this exists).
const GENIE_CDP_PROFILE = resolve(process.env.HOME, '.genie-chrome-cdp');

// Copy of user's Chrome profile (fallback — macOS Keychain usually prevents
// cookie decryption across processes, but Local Storage / localStorage works)
const GENIE_PROFILE = resolve(process.env.HOME, '.genie-chrome-profile');

// Alternative profiles with logged-in sessions
const OPENCLAW_PROFILE = resolve(process.env.HOME, '.openclaw/browser/openclaw/user-data');
const MCP_PROFILE_A = resolve(process.env.HOME, 'Library/Caches/ms-playwright/mcp-chrome-a7c0832');
const MCP_PROFILE_B = resolve(process.env.HOME, 'Library/Caches/ms-playwright/mcp-chrome-2471969');

mkdirSync(SCREENSHOTS_DIR, { recursive: true });

function log(tag, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [CHROME-CTRL] [${tag}] ${msg}`);
}

// ============================================================================
// APPROACH 1: Connect to running Chrome via CDP
// ============================================================================

async function tryConnectCDP() {
  log('CDP', `Trying to connect to existing Chrome at ${CDP_URL}...`);
  try {
    // Quick check if port is open
    const response = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
    const info = await response.json();
    log('CDP', `Found Chrome: ${info.Browser}`);

    const browser = await chromium.connectOverCDP(CDP_URL);
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      log('CDP', 'No contexts found, creating new one');
      const ctx = await browser.newContext();
      return { browser, page: await ctx.newPage(), method: 'cdp-existing' };
    }
    // Use existing context (has cookies/sessions)
    const ctx = contexts[0];
    const pages = ctx.pages();
    // Create a new page in existing context to avoid disrupting user's tabs
    const page = await ctx.newPage();
    log('CDP', `Connected! ${pages.length} existing pages, created new one`);
    return { browser, page, method: 'cdp-existing' };
  } catch (err) {
    log('CDP', `Failed: ${err.message}`);
    return null;
  }
}

// ============================================================================
// APPROACH 1b: Launch a dedicated Genie Chrome with CDP + persistent profile
//
// KEY INSIGHT: Chrome refuses to enable --remote-debugging-port on its
// default user-data-dir (explicit error: "DevTools remote debugging
// requires a non-default data directory"). But with --user-data-dir set
// to a separate path, CDP works perfectly.
//
// Strategy: spawn Chrome with a dedicated genie profile + CDP. If the
// profile is new, the user logs into X/Uber once. Sessions persist.
// On subsequent runs, we just connect to CDP (fast).
// ============================================================================

async function tryLaunchGenieChromeWithCDP() {
  log('GENIE-CDP', `Launching dedicated Genie Chrome with CDP at ${GENIE_CDP_PROFILE}`);

  mkdirSync(GENIE_CDP_PROFILE, { recursive: true });

  // Clean lock files in case of prior ungraceful exit
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(resolve(GENIE_CDP_PROFILE, lock), { force: true }); } catch (e) {}
  }

  // Check if a Genie Chrome is already running on CDP
  try {
    const resp = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (resp.ok) {
      log('GENIE-CDP', 'Genie Chrome already running with CDP, connecting...');
      const browser = await chromium.connectOverCDP(CDP_URL);
      const contexts = browser.contexts();
      const ctx = contexts.length > 0 ? contexts[0] : await browser.newContext();
      const page = await ctx.newPage();
      return { browser, page, method: 'genie-cdp-existing' };
    }
  } catch (e) {
    // Not running — we'll launch it
  }

  // Spawn Chrome with CDP + dedicated profile
  const chromeProc = spawn(CHROME_BIN, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${GENIE_CDP_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    'about:blank',
  ], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  chromeProc.stderr?.on('data', (d) => { stderrBuf += d.toString(); });
  chromeProc.unref();

  // Wait for CDP to come up (usually < 3s)
  for (let i = 0; i < 15; i++) {
    await sleep(500);
    try {
      const resp = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (resp.ok) {
        const info = await resp.json();
        log('GENIE-CDP', `Chrome up: ${info.Browser}`);
        const browser = await chromium.connectOverCDP(CDP_URL);
        const contexts = browser.contexts();
        const ctx = contexts.length > 0 ? contexts[0] : await browser.newContext();
        // Prefer existing page (the about:blank that Chrome opened) to avoid new window
        const existingPages = ctx.pages();
        const page = existingPages.length > 0 ? existingPages[0] : await ctx.newPage();
        log('GENIE-CDP', `Connected! pages=${existingPages.length}`);
        return { browser, page, method: 'genie-cdp-fresh' };
      }
    } catch (e) {}
  }

  log('GENIE-CDP', `Chrome failed to start CDP. stderr: ${stderrBuf.slice(0, 300)}`);
  return null;
}

// ============================================================================
// APPROACH 2a: Copy user's Chrome profile and launch via Playwright
//   This is the most reliable approach — copies cookies/storage to a
//   separate dir so we don't conflict with the user's running Chrome.
// ============================================================================

async function tryCopyProfileLaunch() {
  log('COPY', 'Copying user Chrome profile to isolated dir...');

  if (!existsSync(CHROME_PROFILE)) {
    log('COPY', 'User Chrome profile not found');
    return null;
  }

  try {
    mkdirSync(GENIE_PROFILE, { recursive: true });
    mkdirSync(resolve(GENIE_PROFILE, 'Default'), { recursive: true });

    // Copy the critical session files. We do NOT copy the entire profile
    // (too big, causes lock issues). Just cookies + encryption state.
    const filesToCopy = [
      ['Default/Cookies', 'Default/Cookies'],
      ['Default/Cookies-journal', 'Default/Cookies-journal'],
      ['Default/Login Data', 'Default/Login Data'],
      ['Default/Web Data', 'Default/Web Data'],
      ['Default/Preferences', 'Default/Preferences'],
      ['Default/Secure Preferences', 'Default/Secure Preferences'],
      ['Default/Local Storage', 'Default/Local Storage'],
      ['Default/Session Storage', 'Default/Session Storage'],
      ['Local State', 'Local State'],
    ];

    for (const [src, dst] of filesToCopy) {
      const srcPath = resolve(CHROME_PROFILE, src);
      const dstPath = resolve(GENIE_PROFILE, dst);
      try {
        if (existsSync(srcPath)) {
          execSync(`cp -Rf "${srcPath}" "${dstPath}"`, { stdio: 'ignore' });
        }
      } catch (e) {
        log('COPY', `Could not copy ${src}: ${e.message}`);
      }
    }

    // Clean lock files
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { rmSync(resolve(GENIE_PROFILE, lock), { force: true }); } catch (e) {}
    }

    log('COPY', `Launching Chrome with copied profile at ${GENIE_PROFILE}`);
    const context = await chromium.launchPersistentContext(GENIE_PROFILE, {
      headless: false,
      channel: 'chrome',
      viewport: { width: 1280, height: 900 },
      slowMo: 150,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    const page = context.pages()[0] || await context.newPage();
    log('COPY', 'Launched successfully with user profile cookies');
    return { browser: null, context, page, method: 'copied-profile' };
  } catch (err) {
    log('COPY', `Failed: ${err.message}`);
    return null;
  }
}

// ============================================================================
// APPROACH 2b: Quit Chrome, relaunch with CDP, connect
//   (Unreliable on macOS — Chrome often silently ignores CDP flag)
// ============================================================================

async function tryRelaunchWithCDP() {
  log('RELAUNCH', 'Quitting Chrome and relaunching with CDP...');

  // Gracefully quit Chrome via AppleScript
  try {
    execSync('osascript -e \'tell application "Google Chrome" to quit\'', { timeout: 5000 });
    log('RELAUNCH', 'Sent quit command to Chrome');
  } catch (e) {
    log('RELAUNCH', 'Chrome quit failed, trying kill...');
    try { execSync('pkill -f "Google Chrome"', { timeout: 3000 }); } catch (e2) {}
  }

  // Wait for Chrome to fully exit
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    try {
      const ps = execSync('pgrep -f "Google Chrome.app/Contents/MacOS/Google Chrome" 2>/dev/null', { encoding: 'utf8' }).trim();
      if (!ps) break;
      log('RELAUNCH', `Waiting for Chrome to exit... (attempt ${i + 1})`);
    } catch (e) {
      break; // pgrep returned non-zero = no process found
    }
  }

  // Clean any stale lock files
  const lockFile = resolve(CHROME_PROFILE, 'SingletonLock');
  try { rmSync(lockFile, { force: true }); } catch (e) {}

  // Relaunch Chrome with CDP enabled
  log('RELAUNCH', `Launching Chrome with --remote-debugging-port=${CDP_PORT}...`);
  const chromeProc = spawn(CHROME_BIN, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    '--restore-last-session',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  chromeProc.unref();

  // Wait for CDP to become available
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      const response = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const info = await response.json();
        log('RELAUNCH', `Chrome is up! ${info.Browser}`);

        // Connect via Playwright
        const browser = await chromium.connectOverCDP(CDP_URL);
        const contexts = browser.contexts();
        const ctx = contexts.length > 0 ? contexts[0] : await browser.newContext();
        const page = await ctx.newPage();
        log('RELAUNCH', `Connected via CDP after relaunch. Contexts: ${contexts.length}`);
        return { browser, page, method: 'cdp-relaunch' };
      }
    } catch (e) {
      log('RELAUNCH', `Waiting for CDP... (attempt ${i + 1})`);
    }
  }

  log('RELAUNCH', 'Failed to connect after relaunch');
  return null;
}

// ============================================================================
// APPROACH 3: Launch Playwright with an existing profile (OpenClaw / MCP)
// ============================================================================

async function tryProfileLaunch(profilePath, label) {
  if (!existsSync(profilePath)) {
    log('PROFILE', `${label} profile not found at ${profilePath}`);
    return null;
  }

  // Clean singleton lock
  const lockFile = resolve(profilePath, 'SingletonLock');
  try { rmSync(lockFile, { force: true }); } catch (e) {}

  log('PROFILE', `Launching with ${label} profile: ${profilePath}`);
  try {
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      channel: 'chrome', // Use system Chrome, not Playwright's Chromium
      viewport: { width: 1280, height: 900 },
      slowMo: 150,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    const page = context.pages()[0] || await context.newPage();
    log('PROFILE', `Launched with ${label} profile successfully`);
    return { browser: null, context, page, method: `profile-${label}` };
  } catch (err) {
    log('PROFILE', `${label} failed: ${err.message}`);
    return null;
  }
}

// ============================================================================
// getPage() — Master connector, tries all approaches
// ============================================================================

let _cached = null;

export async function getPage() {
  if (_cached && !_cached.page.isClosed()) {
    return _cached;
  }

  // Approach 1a: Try connecting to already-running CDP on port 9222
  let result = await tryConnectCDP();
  if (result) { _cached = result; return result; }

  // Approach 1b: Launch dedicated Genie Chrome with CDP (PRIMARY)
  //   This is the winner: reliable CDP connection + persistent sessions.
  //   On first run, user logs into X/Uber once. On subsequent runs, instant.
  result = await tryLaunchGenieChromeWithCDP();
  if (result) { _cached = result; return result; }

  // Approach 2a: Copy user's Chrome profile (fallback — macOS Keychain
  //   usually prevents cookie decryption cross-process, so sessions rarely transfer)
  result = await tryCopyProfileLaunch();
  if (result) { _cached = result; return result; }

  // Approach 2b: Relaunch Chrome with CDP (flaky on macOS, opt-in via env)
  if (process.env.GENIE_ALLOW_RELAUNCH === '1') {
    result = await tryRelaunchWithCDP();
    if (result) { _cached = result; return result; }
  }

  // Approach 3a: OpenClaw profile (had X, LinkedIn, Reddit sessions — may be expired)
  result = await tryProfileLaunch(OPENCLAW_PROFILE, 'openclaw');
  if (result) { _cached = result; return result; }

  // Approach 3b: MCP browser profile (was working today for Tesla)
  result = await tryProfileLaunch(MCP_PROFILE_A, 'mcp-a');
  if (result) { _cached = result; return result; }

  result = await tryProfileLaunch(MCP_PROFILE_B, 'mcp-b');
  if (result) { _cached = result; return result; }

  throw new Error('All browser connection approaches failed. Make sure Chrome is installed.');
}

// ============================================================================
// postTweet(text) — Post a tweet on X/Twitter
// ============================================================================

export async function postTweet(text) {
  log('TWEET', `Posting tweet: "${text.slice(0, 60)}..."`);
  const { page, method } = await getPage();
  const screenshots = [];

  const screenshot = async (name) => {
    const path = `${SCREENSHOTS_DIR}/tweet-${name}-${Date.now()}.png`;
    await page.screenshot({ path });
    screenshots.push(path);
    log('TWEET', `Screenshot: ${path}`);
    return path;
  };

  try {
    // Navigate to compose
    log('TWEET', 'Navigating to x.com/compose/post...');
    await page.goto('https://x.com/compose/post', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(3000);
    await screenshot('01-loaded');

    // Check if we're on a login page
    const url = page.url();
    if (url.includes('/login') || url.includes('/i/flow/login')) {
      log('TWEET', 'NOT LOGGED IN — redirected to login page');
      await screenshot('01-not-logged-in');
      return { status: 'not_logged_in', text, method, screenshots };
    }

    // Find the compose box
    const composeSelectors = [
      'div[data-testid="tweetTextarea_0"]',
      'div[role="textbox"][data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"][data-testid="tweetTextarea_0"]',
      'div.public-DraftEditor-content',
      'div[contenteditable="true"]',
    ];

    let composeBox = null;
    for (const sel of composeSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          composeBox = el;
          log('TWEET', `Found compose box: ${sel}`);
          break;
        }
      } catch (e) {}
    }

    if (!composeBox) {
      log('TWEET', 'Compose box not found');
      await screenshot('02-no-compose');
      return { status: 'compose_not_found', text, method, screenshots };
    }

    // Type the tweet
    log('TWEET', `Typing ${text.length} characters...`);
    await composeBox.click();
    await sleep(500);
    await page.keyboard.type(text, { delay: 25 });
    await sleep(1000);
    await screenshot('02-typed');

    // Click Post button
    const postSelectors = [
      'button[data-testid="tweetButton"]',
      'button[data-testid="tweetButtonInline"]',
      'div[data-testid="tweetButton"]',
    ];

    let posted = false;
    for (const sel of postSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          posted = true;
          log('TWEET', 'Post button clicked!');
          break;
        }
      } catch (e) {}
    }

    if (!posted) {
      log('TWEET', 'Post button not found');
      await screenshot('03-no-button');
      return { status: 'post_button_not_found', text, method, screenshots };
    }

    await sleep(3000);
    await screenshot('03-posted');
    log('TWEET', 'Tweet posted successfully!');
    return { status: 'posted', text, method, screenshots };

  } catch (err) {
    log('TWEET', `Error: ${err.message}`);
    try { await screenshot('error'); } catch (e) {}
    return { status: 'error', error: err.message, text, method, screenshots };
  }
}

// ============================================================================
// orderUberEats(query, address) — Search and add to cart on Uber Eats
// ============================================================================

export async function orderUberEats(query, address = '') {
  log('UBER', `Ordering: "${query}" ${address ? `near ${address}` : ''}`);
  const { page, method } = await getPage();
  const screenshots = [];

  const screenshot = async (name) => {
    const path = `${SCREENSHOTS_DIR}/uber-${name}-${Date.now()}.png`;
    await page.screenshot({ path });
    screenshots.push(path);
    log('UBER', `Screenshot: ${path}`);
    return path;
  };

  try {
    // Navigate to Uber Eats
    const searchUrl = query
      ? `https://www.ubereats.com/search?q=${encodeURIComponent(query)}`
      : 'https://www.ubereats.com';
    log('UBER', `Navigating to ${searchUrl}`);
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(3000);
    await screenshot('01-loaded');

    // Check if logged in (look for sign-in button)
    const url = page.url();
    if (url.includes('/login') || url.includes('/auth')) {
      log('UBER', 'Not logged in');
      await screenshot('01-not-logged-in');
      return { status: 'not_logged_in', query, method, screenshots };
    }

    // Handle address modal if it appears
    const addressModal = page.locator('input[placeholder*="address"], input[placeholder*="delivery"], input[aria-label*="address"]').first();
    try {
      if (await addressModal.isVisible({ timeout: 3000 })) {
        if (address) {
          log('UBER', `Entering delivery address: ${address}`);
          await addressModal.fill(address);
          await sleep(1500);
          // Click first suggestion
          const suggestion = page.locator('ul[role="listbox"] li, div[data-testid*="suggestion"], div[role="option"]').first();
          try {
            if (await suggestion.isVisible({ timeout: 3000 })) {
              await suggestion.click();
              await sleep(2000);
            }
          } catch (e) {
            // Try pressing Enter instead
            await page.keyboard.press('Enter');
            await sleep(2000);
          }
          await screenshot('02-address-set');
        }
      }
    } catch (e) {
      log('UBER', 'No address modal found (likely already set)');
    }

    // If we didn't search via URL, use the search box
    if (!query) {
      return { status: 'loaded', method, screenshots, message: 'Uber Eats loaded, no search query provided' };
    }

    // Wait for search results
    await sleep(3000);
    await screenshot('03-search-results');

    // Click on the first restaurant/item result
    const resultSelectors = [
      'a[data-testid="store-card"]',
      'a[href*="/store/"]',
      'div[data-testid="feed-item"] a',
      'a[data-testid*="store"]',
      // Generic restaurant card links
      'main a[href*="/store/"]',
    ];

    let clicked = false;
    for (const sel of resultSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          const name = await el.textContent().catch(() => 'unknown');
          log('UBER', `Clicking first result: ${name.slice(0, 50)}`);
          await el.click();
          clicked = true;
          break;
        }
      } catch (e) {}
    }

    if (!clicked) {
      log('UBER', 'No restaurant results found');
      await screenshot('03-no-results');
      return { status: 'no_results', query, method, screenshots };
    }

    await sleep(3000);
    await screenshot('04-restaurant');

    // Click on first menu item
    const menuItemSelectors = [
      'button[data-testid*="menu-item"]',
      'li[data-testid*="menu-item"] button',
      'div[data-testid*="menu-item"]',
      'ul li button',
    ];

    for (const sel of menuItemSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          log('UBER', 'Clicking first menu item');
          await el.click();
          break;
        }
      } catch (e) {}
    }

    await sleep(2000);
    await screenshot('05-item-detail');

    // Click Add to Cart / Add to Order button
    const addCartSelectors = [
      'button[data-testid*="add-to-cart"]',
      'button:has-text("Add to Cart")',
      'button:has-text("Add to Order")',
      'button:has-text("Add 1 to order")',
      'span:has-text("Add to Cart")',
    ];

    let addedToCart = false;
    for (const sel of addCartSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          log('UBER', 'Clicking Add to Cart');
          await el.click();
          addedToCart = true;
          break;
        }
      } catch (e) {}
    }

    await sleep(2000);
    await screenshot('06-added');

    log('UBER', addedToCart ? 'Item added to cart!' : 'Could not find Add to Cart button');
    return {
      status: addedToCart ? 'added_to_cart' : 'restaurant_opened',
      query,
      method,
      screenshots,
    };

  } catch (err) {
    log('UBER', `Error: ${err.message}`);
    try { await screenshot('error'); } catch (e) {}
    return { status: 'error', error: err.message, query, method, screenshots };
  }
}

// ============================================================================
// loginFlow(site) — Opens a site in Genie Chrome and waits for user to log in
//   Used once to establish sessions. After this, tweet/uber calls "just work".
// ============================================================================

export async function loginFlow(site = 'all') {
  log('LOGIN', `Opening login pages for: ${site}`);
  const { page, browser, context } = await getPage();

  const sites = {
    x: 'https://x.com/login',
    twitter: 'https://x.com/login',
    uber: 'https://www.ubereats.com',
    ubereats: 'https://www.ubereats.com',
  };

  try {
    if (site === 'all') {
      log('LOGIN', 'Opening X (Twitter) login...');
      await page.goto(sites.x, { waitUntil: 'domcontentloaded', timeout: 30000 });
      log('LOGIN', '>>> Log into X/Twitter in the browser window <<<');
      log('LOGIN', 'When done, press Enter in this terminal to continue to Uber Eats...');
      await new Promise((res) => process.stdin.once('data', res));

      const ctx = context || browser?.contexts()[0];
      const uberPage = ctx ? await ctx.newPage() : page;
      await uberPage.goto(sites.uber, { waitUntil: 'domcontentloaded', timeout: 30000 });
      log('LOGIN', '>>> Log into Uber Eats in the browser window <<<');
      log('LOGIN', 'When done, press Enter to exit (sessions are now saved)...');
      await new Promise((res) => process.stdin.once('data', res));
    } else {
      const url = sites[site.toLowerCase()] || site;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      log('LOGIN', `>>> Log into ${site} in the browser window <<<`);
      log('LOGIN', 'When done, press Enter in this terminal to exit...');
      await new Promise((res) => process.stdin.once('data', res));
    }

    log('LOGIN', 'Sessions saved to Genie Chrome profile. You can now use tweet/uber commands.');
    log('LOGIN', 'IMPORTANT: Keep the Genie Chrome window open (minimize it) so CDP stays live.');
    return { status: 'ok' };
  } catch (err) {
    log('LOGIN', `Error: ${err.message}`);
    return { status: 'error', error: err.message };
  }
}

// ============================================================================
// CLI
// ============================================================================

const isMain = process.argv[1]?.includes('chrome-control');
if (isMain) {
  const command = process.argv[2];

  if (command === 'test') {
    log('TEST', 'Testing browser connection...');
    try {
      const { page, method } = await getPage();
      log('TEST', `Connected via: ${method}`);
      await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const title = await page.title();
      log('TEST', `Page title: ${title}`);
      const ssPath = `${SCREENSHOTS_DIR}/test-${Date.now()}.png`;
      await page.screenshot({ path: ssPath });
      log('TEST', `Screenshot: ${ssPath}`);
      log('TEST', 'SUCCESS — Browser automation is working!');
    } catch (err) {
      log('TEST', `FAILED: ${err.message}`);
      process.exit(1);
    }

  } else if (command === 'tweet') {
    const text = process.argv[3];
    if (!text) { console.error('Usage: node chrome-control.mjs tweet "text"'); process.exit(1); }
    const result = await postTweet(text);
    console.log(JSON.stringify(result, null, 2));

  } else if (command === 'login') {
    const site = process.argv[3] || 'all';
    await loginFlow(site);
    process.exit(0);

  } else if (command === 'uber') {
    const query = process.argv[3] || 'pizza';
    const address = process.argv[4] || '';
    const result = await orderUberEats(query, address);
    console.log(JSON.stringify(result, null, 2));

  } else {
    console.log(`
MischiefClaw Browser Control
=============================
First-time setup (once):
  node src/browser/chrome-control.mjs login           — Log into X + Uber in Genie Chrome
  node src/browser/chrome-control.mjs login x         — Log into X only
  node src/browser/chrome-control.mjs login uber      — Log into Uber Eats only

Everyday use:
  node src/browser/chrome-control.mjs test                    — Test browser connection
  node src/browser/chrome-control.mjs tweet "Hello world!"    — Post a tweet
  node src/browser/chrome-control.mjs uber "pizza" "10014"    — Order on Uber Eats

How it works:
  - Uses a dedicated Chrome profile at ~/.genie-chrome-cdp (not your main Chrome)
  - Chrome launches with --remote-debugging-port=9222 + --user-data-dir (required by Chrome)
  - Sessions persist across runs in the Genie profile
  - KEEP THE GENIE CHROME WINDOW OPEN (minimize it) so CDP stays live
`);
  }
}
