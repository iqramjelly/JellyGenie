#!/usr/bin/env node
// Screenshot Taker
// Uses Playwright to capture a full-page screenshot of a URL (headless)
// Usage: node take-screenshot.mjs --url https://... --output /path/to/file.png
// Exports: takeScreenshot(url, outputPath)

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

function log(msg) {
  console.log(`[GENIE] [SCREENSHOT] ${msg}`);
}

/**
 * Take a full-page screenshot of a URL using headless Chromium.
 * @param {string} url - The URL to screenshot
 * @param {string} [outputPath] - Where to save the PNG (default: /tmp/genie/screenshots/{timestamp}.png)
 * @returns {Promise<{path: string, width: number, height: number}>}
 */
export async function takeScreenshot(url, outputPath) {
  const finalPath = outputPath || `/tmp/genie/screenshots/${Date.now()}.png`;

  // Ensure output directory exists
  mkdirSync(dirname(finalPath), { recursive: true });

  log(`Capturing: ${url}`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
    });

    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Get page dimensions
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    await page.screenshot({
      path: finalPath,
      fullPage: true,
    });

    log(`Saved: ${finalPath} (${dimensions.width}x${dimensions.height})`);

    return {
      path: finalPath,
      width: dimensions.width,
      height: dimensions.height,
    };
  } catch (err) {
    log(`Failed: ${err.message}`);
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// CLI mode
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf('--url');
  const outIdx = args.indexOf('--output');

  const url = urlIdx !== -1 ? args[urlIdx + 1] : args[0];
  const output = outIdx !== -1 ? args[outIdx + 1] : undefined;

  if (!url) {
    console.error('Usage: node take-screenshot.mjs --url <URL> [--output <path>]');
    process.exit(1);
  }

  takeScreenshot(url, output)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
