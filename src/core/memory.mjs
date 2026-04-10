#!/usr/bin/env node
// Per-User Memory (local JSON)
// Stores: past wishes, preferences, builds, network connections
// Location: ~/.genie/users/{username}.json
// Exports: getUser(username), updateUser(username, data), addWish(username, wish), getUserSummary(username)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const USERS_DIR = join(homedir(), '.genie', 'users');

/**
 * Ensure the users directory exists.
 */
function ensureDir() {
  if (!existsSync(USERS_DIR)) {
    mkdirSync(USERS_DIR, { recursive: true });
  }
}

/**
 * Get the file path for a user's JSON file.
 */
function userPath(username) {
  const safe = String(username).replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(USERS_DIR, `${safe}.json`);
}

/**
 * Read a user's JSON file, return parsed object or null.
 */
function readUser(username) {
  try {
    const raw = readFileSync(userPath(username), 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Write a user object to disk.
 */
function writeUser(username, data) {
  ensureDir();
  writeFileSync(userPath(username), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Create a fresh user object.
 */
function createUser(username) {
  const now = new Date().toISOString();
  return {
    username: String(username),
    firstSeen: now,
    lastSeen: now,
    wishCount: 0,
    wishes: [],
    preferences: {
      style: 'dark',
      colors: {},
    },
  };
}

/**
 * Get a user object by username. Returns the user object or null if not found.
 * @param {string} username
 * @returns {object|null}
 */
export function getUser(username) {
  if (!username) return null;
  return readUser(username);
}

/**
 * Update (merge) data into a user object. Creates the user if they don't exist.
 * @param {string} username
 * @param {object} data - Fields to merge into the user object
 * @returns {object} The updated user object
 */
export function updateUser(username, data) {
  if (!username) return null;

  let user = readUser(username);
  if (!user) {
    user = createUser(username);
  }

  // Shallow merge top-level fields
  for (const [key, value] of Object.entries(data)) {
    if (key === 'preferences' && typeof value === 'object' && user.preferences) {
      // Deep merge preferences
      user.preferences = { ...user.preferences, ...value };
      if (value.colors && user.preferences.colors) {
        user.preferences.colors = { ...user.preferences.colors, ...value.colors };
      }
    } else {
      user[key] = value;
    }
  }

  user.lastSeen = new Date().toISOString();
  writeUser(username, user);
  return user;
}

/**
 * Append a wish to a user's wishes array. Creates the user if they don't exist.
 * @param {string} username
 * @param {object} wish - { date, type, title, url, clipId }
 * @returns {object} The updated user object
 */
export function addWish(username, wish) {
  if (!username) return null;

  let user = readUser(username);
  if (!user) {
    user = createUser(username);
  }

  const wishEntry = {
    date: wish.date || new Date().toISOString(),
    type: wish.type || 'UNKNOWN',
    title: wish.title || '',
    url: wish.url || null,
    clipId: wish.clipId || null,
  };

  user.wishes.push(wishEntry);
  user.wishCount = user.wishes.length;
  user.lastSeen = new Date().toISOString();

  writeUser(username, user);
  return user;
}

/**
 * Get a one-line summary for Telegram.
 * @param {string} username
 * @returns {string}
 */
export function getUserSummary(username) {
  if (!username) return '';

  const user = readUser(username);
  if (!user) {
    return `Welcome, new wisher @${username}! Make your first wish.`;
  }

  const count = user.wishCount || 0;
  if (count === 0) {
    return `Welcome back @${username}! No wishes yet — make your first one.`;
  }

  // Find the last wish that has a URL (most recent build)
  const lastBuild = [...user.wishes].reverse().find(w => w.url);
  const lastBuildInfo = lastBuild ? ` Last build: ${lastBuild.url}` : '';

  return `Welcome back @${username}! You've wished ${count} time${count !== 1 ? 's' : ''}.${lastBuildInfo}`;
}
