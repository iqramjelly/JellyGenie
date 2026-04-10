#!/usr/bin/env node
// Vercel Deployer
// Takes a directory -> runs vercel deploy --yes --prod -> returns live URL
// Usage: import { deployToVercel } from './deploy-vercel.mjs'

import { execSync } from 'node:child_process';

/**
 * Deploy a directory to Vercel.
 * @param {string} dir - Absolute path to the directory to deploy
 * @param {string} projectName - Vercel project name
 * @returns {{ url: string, deployTime: number }}
 */
export function deployToVercel(dir, projectName) {
  const startTime = Date.now();

  // Sanitize project name — Vercel rules: lowercase, alphanumeric + dashes, max 52 chars
  const sanitizedName = (projectName || 'genie-site')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52);

  console.log(`[DEPLOY-VERCEL] Deploying ${dir} as "${sanitizedName}"...`);

  try {
    // Run vercel deploy with prod flag
    const args = ['deploy', '--yes', '--prod', '--name', sanitizedName];

    const stdout = execSync(`npx vercel ${args.join(' ')}`, {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 120_000, // 2 minute timeout
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure Vercel CLI doesn't prompt
        VERCEL_ORG_ID: process.env.VERCEL_ORG_ID || '',
        VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID || '',
      },
    });

    const deployTime = Date.now() - startTime;

    // The deploy URL CLI prints is the SSO-protected preview URL.
    // The public production URL is the bare project alias: https://{name}.vercel.app
    const previewUrl = (stdout.match(/https:\/\/[^\s]+\.vercel\.app[^\s]*/) || [])[0]?.trim() || null;
    const productionUrl = `https://${sanitizedName}.vercel.app`;

    // Verify production URL is live and public (retries briefly, alias takes a sec to propagate)
    const live = waitForUrl(productionUrl, 15_000);
    const url = live ? productionUrl : (previewUrl || productionUrl);

    console.log(`[DEPLOY-VERCEL] Live at: ${url}${live ? '' : ' (production alias not yet verified)'}`);
    if (previewUrl) console.log(`[DEPLOY-VERCEL] Preview (SSO-protected): ${previewUrl}`);
    console.log(`[DEPLOY-VERCEL] Deploy time: ${(deployTime / 1000).toFixed(1)}s`);

    return { url, previewUrl, deployTime };
  } catch (err) {
    const deployTime = Date.now() - startTime;
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';

    // Even on error, Vercel sometimes outputs the URL
    const urlMatch = (stdout + stderr).match(/https:\/\/[^\s]+\.vercel\.app[^\s]*/);
    if (urlMatch) {
      console.warn(`[DEPLOY-VERCEL] Deploy had warnings but URL found: ${urlMatch[0]}`);
      return { url: urlMatch[0].trim(), deployTime };
    }

    console.error(`[DEPLOY-VERCEL] Deploy failed after ${(deployTime / 1000).toFixed(1)}s`);
    console.error(`[DEPLOY-VERCEL] stderr: ${stderr}`);
    console.error(`[DEPLOY-VERCEL] stdout: ${stdout}`);
    throw new Error(`Vercel deploy failed: ${err.message}`);
  }
}

function extractAnyUrl(text) {
  const match = text.match(/https:\/\/[^\s]+/);
  return match ? match[0].trim() : null;
}

/**
 * Poll a URL until it returns 200, up to timeoutMs. Synchronous via execSync + curl.
 * Used to confirm the Vercel production alias has propagated and is publicly reachable.
 */
function waitForUrl(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const code = execSync(`curl -sI -o /dev/null -w '%{http_code}' ${JSON.stringify(url)}`, {
        encoding: 'utf-8',
        timeout: 5_000,
      }).trim();
      if (code === '200') return true;
    } catch (_) {}
    // brief sleep via curl --max-time trick
    try { execSync('sleep 1'); } catch (_) {}
  }
  return false;
}

// CLI mode
if (process.argv[1] && process.argv[1].endsWith('deploy-vercel.mjs')) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const dir = getArg('--dir');
  const name = getArg('--name') || 'genie-site';

  if (!dir) {
    console.error('Usage: node deploy-vercel.mjs --dir /path/to/site [--name project-name]');
    process.exit(1);
  }

  const result = deployToVercel(dir, name);
  console.log(JSON.stringify(result, null, 2));
}
