// Genie — Dispatch Registry
// Persistent record of all jelly dispatches: clipId → roomId, status, cost, etc.
// Survives server restarts. Single source of truth for dedup, room reuse, and cancellation.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const GENIE_DIR = resolve(homedir(), '.jellygenie');
const REGISTRY_PATH = resolve(GENIE_DIR, 'dispatch-registry.json');
const MAX_RESULT_LEN = 500;
const MAX_CONSECUTIVE_FAILURES = 3;

function log(msg) {
  console.log(`[GENIE] [REGISTRY] ${msg}`);
}

function ensureDir() {
  if (!existsSync(GENIE_DIR)) mkdirSync(GENIE_DIR, { recursive: true });
}

// ─── In-memory cache (authoritative for this single-process server) ──────────
let _cache = null;

function loadRegistry() {
  if (_cache) return _cache;
  ensureDir();
  if (!existsSync(REGISTRY_PATH)) {
    _cache = { version: 1, dispatches: {} };
    return _cache;
  }
  try {
    _cache = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
    if (!_cache.dispatches) _cache.dispatches = {};
    if (!_cache.version) _cache.version = 1;
  } catch (err) {
    log(`Failed to read registry: ${err.message}`);
    _cache = { version: 1, dispatches: {} };
  }
  return _cache;
}

function saveRegistry() {
  ensureDir();
  try {
    writeFileSync(REGISTRY_PATH, JSON.stringify(_cache, null, 2), 'utf-8');
  } catch (err) {
    log(`Failed to write registry: ${err.message}`);
  }
}

// ─── Read operations ─────────────────────────────────────────────────────────

export function getDispatch(clipId) {
  const reg = loadRegistry();
  return reg.dispatches[clipId] || null;
}

export function getAllDispatches() {
  return loadRegistry().dispatches;
}

export function getClipRoom(clipId) {
  const entry = getDispatch(clipId);
  return entry?.roomId || null;
}

export function getAllClipRooms() {
  const reg = loadRegistry();
  const map = new Map();
  for (const [clipId, entry] of Object.entries(reg.dispatches)) {
    if (entry.roomId) map.set(clipId, entry.roomId);
  }
  return map;
}

export function isDispatched(clipId) {
  const entry = getDispatch(clipId);
  if (!entry) return false;
  // Considered dispatched unless it errored out past max retries
  return entry.status !== 'error' || entry.consecutiveFailures < MAX_CONSECUTIVE_FAILURES;
}

export function shouldRetry(clipId) {
  const entry = getDispatch(clipId);
  if (!entry) return true;
  return entry.consecutiveFailures < MAX_CONSECUTIVE_FAILURES;
}

export function getRunningDispatches() {
  const reg = loadRegistry();
  return Object.values(reg.dispatches).filter(e => e.status === 'running');
}

// ─── Write operations ────────────────────────────────────────────────────────

export function createDispatch({ clipId, clipTitle, creator, roomId = null }) {
  const reg = loadRegistry();
  // Don't overwrite existing completed dispatches
  if (reg.dispatches[clipId] && reg.dispatches[clipId].status === 'done') {
    return reg.dispatches[clipId];
  }
  reg.dispatches[clipId] = {
    clipId,
    roomId,
    clipTitle: clipTitle || '',
    creator: creator || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    model: null,
    turns: null,
    usdCost: null,
    result: null,
    pid: null,
    errorMessage: null,
    consecutiveFailures: reg.dispatches[clipId]?.consecutiveFailures || 0,
  };
  saveRegistry();
  log(`Created dispatch: ${clipId} "${clipTitle}"`);
  return reg.dispatches[clipId];
}

export function updateDispatch(clipId, updates) {
  const reg = loadRegistry();
  if (!reg.dispatches[clipId]) return null;
  Object.assign(reg.dispatches[clipId], updates);
  saveRegistry();
  return reg.dispatches[clipId];
}

export function markRunning(clipId, pid) {
  return updateDispatch(clipId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    pid: pid || null,
  });
}

export function markDone(clipId, { result, turns, usdCost, model } = {}) {
  return updateDispatch(clipId, {
    status: 'done',
    completedAt: new Date().toISOString(),
    pid: null,
    result: result ? result.slice(0, MAX_RESULT_LEN) : null,
    turns: turns ?? null,
    usdCost: usdCost ?? null,
    model: model || null,
    consecutiveFailures: 0,
  });
}

export function markCancelled(clipId) {
  return updateDispatch(clipId, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    pid: null,
  });
}

export function markError(clipId, errorMessage) {
  const reg = loadRegistry();
  const entry = reg.dispatches[clipId];
  if (!entry) return null;
  const failures = (entry.consecutiveFailures || 0) + 1;
  return updateDispatch(clipId, {
    status: failures >= MAX_CONSECUTIVE_FAILURES ? 'error' : 'pending',
    completedAt: new Date().toISOString(),
    pid: null,
    errorMessage: errorMessage || null,
    consecutiveFailures: failures,
  });
}

// ─── Cancel (kills child process) ────────────────────────────────────────────

export function cancelDispatch(clipId) {
  const entry = getDispatch(clipId);
  if (!entry || entry.status !== 'running') return false;
  if (entry.pid) {
    try {
      process.kill(entry.pid, 'SIGTERM');
      setTimeout(() => { try { process.kill(entry.pid, 'SIGKILL'); } catch {} }, 5000);
    } catch {}
  }
  markCancelled(clipId);
  log(`Cancelled dispatch: ${clipId} (pid=${entry.pid})`);
  return true;
}
