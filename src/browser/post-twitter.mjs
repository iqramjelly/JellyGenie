#!/usr/bin/env node
// Genie — Post a tweet via headed Playwright browser
// Opens Chrome, navigates to x.com/compose/post, types and posts
// Usage: node src/browser/post-twitter.mjs --text "My tweet text"
// Export: postTweet(text)

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

// Use the REAL system Chrome user data dir — already logged into Twitter
// We use a COPY to avoid lock conflicts with your running Chrome
const SYSTEM_CHROME_PROFILE = resolve(process.env.HOME, 'Library/Application Support/Google/Chrome');
const GENIE_CHROME_COPY = resolve(process.env.HOME, '.genie-chrome-copy');

function log(step, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [GENIE] [TWITTER] [${step}] ${msg}`);
}

/**
 * Post a tweet using headed Playwright browser.
 * @param {string} text - Tweet text
 * @returns {Promise<{status: string, text: string, screenshots: string[]}>}
 */
export async function postTweet(text) {
  mkdirSync('/tmp/genie/screenshots', { recursive: true });
  mkdirSync(GENIE_CHROME_COPY, { recursive: true });

  log('INIT', 'Launching Chrome with your real profile cookies...');

  // Copy Chrome cookies to our profile dir (avoids lock conflict with running Chrome)
  try {
    const { execSync } = await import('child_process');
    mkdirSync(GENIE_CHROME_COPY + '/Default', { recursive: true });
    // Copy cookies and login data from system Chrome
    for (const f of ['Cookies', 'Login Data', 'Web Data', 'Preferences', 'Secure Preferences']) {
      try {
        execSync(`cp -f "${SYSTEM_CHROME_PROFILE}/Default/${f}" "${GENIE_CHROME_COPY}/Default/${f}" 2>/dev/null`);
      } catch (e) {}
    }
    // Copy Local State for encryption keys
    try {
      execSync(`cp -f "${SYSTEM_CHROME_PROFILE}/Local State" "${GENIE_CHROME_COPY}/Local State" 2>/dev/null`);
    } catch (e) {}
    log('INIT', 'Copied Chrome cookies to genie profile');
  } catch (err) {
    log('INIT', `Could not copy Chrome cookies: ${err.message}`);
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(GENIE_CHROME_COPY, {
      headless: false,
      channel: 'chrome',
      viewport: { width: 1280, height: 900 },
      slowMo: 200,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });
  } catch (err) {
    log('INIT', `Persistent context failed: ${err.message}. Trying fresh context...`);
    const browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      slowMo: 200,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  }

  const page = context.pages()[0] || await context.newPage();
  const screenshots = [];

  try {
    // Navigate to Twitter compose
    log('NAV', 'Opening x.com...');
    await page.goto('https://x.com/compose/post', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    let ssPath = `/tmp/genie/screenshots/twitter-01-compose-${Date.now()}.png`;
    await page.screenshot({ path: ssPath });
    screenshots.push(ssPath);

    // Check if we're logged in (compose box should be visible)
    const composeSelectors = [
      'div[data-testid="tweetTextarea_0"]',
      'div[role="textbox"][data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"][data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"]',
    ];

    let composeBox = null;
    for (const sel of composeSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          composeBox = el;
          log('COMPOSE', 'Found compose box');
          break;
        }
      } catch (e) {}
    }

    if (!composeBox) {
      log('AUTH', 'Not logged in or compose box not found. Taking screenshot for debug.');
      ssPath = `/tmp/genie/screenshots/twitter-not-logged-in-${Date.now()}.png`;
      await page.screenshot({ path: ssPath });
      screenshots.push(ssPath);
      return { status: 'not_logged_in', text, screenshots };
    }

    // Type the tweet
    log('COMPOSE', `Typing tweet (${text.length} chars)...`);
    await composeBox.click();
    await page.keyboard.type(text, { delay: 30 });
    await page.waitForTimeout(1000);

    ssPath = `/tmp/genie/screenshots/twitter-02-typed-${Date.now()}.png`;
    await page.screenshot({ path: ssPath });
    screenshots.push(ssPath);

    // Click the Post button
    log('POST', 'Clicking Post button...');
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
          log('POST', 'Tweet posted!');
          break;
        }
      } catch (e) {}
    }

    if (!posted) {
      log('POST', 'Could not find Post button');
      return { status: 'post_button_not_found', text, screenshots };
    }

    await page.waitForTimeout(3000);

    ssPath = `/tmp/genie/screenshots/twitter-03-posted-${Date.now()}.png`;
    await page.screenshot({ path: ssPath });
    screenshots.push(ssPath);

    log('DONE', '✅ Tweet posted successfully');
    return { status: 'posted', text, screenshots };

  } catch (err) {
    log('ERROR', err.message);
    const ssPath = `/tmp/genie/screenshots/twitter-error-${Date.now()}.png`;
    try { await page.screenshot({ path: ssPath }); screenshots.push(ssPath); } catch (e) {}
    return { status: 'error', error: err.message, text, screenshots };
  }
  // Keep browser open briefly so audience can see
}

// CLI mode
const isMain = process.argv[1]?.endsWith('post-twitter.mjs');
if (isMain) {
  const textIdx = process.argv.indexOf('--text');
  const text = textIdx !== -1 ? process.argv[textIdx + 1] : process.argv[2];
  if (!text) {
    console.error('Usage: node post-twitter.mjs --text "tweet text"');
    process.exit(1);
  }
  const result = await postTweet(text);
  console.log(JSON.stringify(result, null, 2));
}
