// Genie — JellyJelly Chat Client
// WebSocket client for JellyJelly Realtime Chat API
// Handles: room creation, messaging, monitoring, heartbeat, reconnect
// API: wss://api.jellyjelly.com/chat?auth_token={JWT}

import { randomUUID } from 'crypto';

let saveMessageFn = null;
try { saveMessageFn = (await import('./chat-history.mjs')).saveMessage; } catch {}

const WS_URL = 'wss://api.jellyjelly.com/chat';
const RECONNECT_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 15_000;
const GENIE_USER_ID = process.env.JELLYGENIE_BOT_USER_ID || '13b132a6-6520-46b6-a563-2d6d2ce5149f';
const WOBBLES_USER_ID = process.env.JELLYGENIE_ALT_USER_ID || '0c89b349-7c64-4242-89a6-9b589cd35665';

let ws = null;
let reconnectTimer = null;
let intentionalClose = false;
let connectedUser = null;

// Track nonces of messages WE sent, so monitors can ignore our own echoes
const sentNonces = new Set();
// Map roomId → human-readable room name for history
const roomNames = new Map();
// Map clipId → roomId — persistent so same clip always uses same room
const clipRooms = new Map();

// Pending nonce-based requests
const pendingRequests = new Map();
// One-shot waiters for specific event types (e.g. room.active)
const eventWaiters = [];
// Active message monitors by roomId
const monitors = new Map();

function log(msg) { console.log(`[GENIE] [CHAT] ${msg}`); }
function getToken() { return process.env.JELLY_AUTH_TOKEN || null; }
function isDisabled() { return !getToken(); }

// ─── Send raw JSON ──────────────────────────────────────────────────────────

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

// Send with nonce, wait for response matching that nonce
function sendWithNonce(payload) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
    const nonce = randomUUID().slice(0, 32);
    const msg = { ...payload, nonce };
    const timeout = setTimeout(() => {
      pendingRequests.delete(nonce);
      reject(new Error(`Timeout: ${payload.type}`));
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(nonce, { resolve, reject, timeout });
    ws.send(JSON.stringify(msg));
  });
}

// Wait for next event of a specific type
function waitForEvent(type, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = eventWaiters.findIndex(w => w._id === id);
      if (idx >= 0) eventWaiters.splice(idx, 1);
      reject(new Error(`Timeout waiting for ${type}`));
    }, timeoutMs);
    const id = randomUUID();
    eventWaiters.push({ type, resolve, timeout, _id: id });
  });
}

// ─── Message Handler ────────────────────────────────────────────────────────

function handleMessage(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  // Server ping → respond with pong
  if (data.type === 'ping') {
    send({ type: 'pong' });
    return;
  }

  // Connection ready — store user info
  if (data.type === 'connection.ready') {
    connectedUser = data.data?.user || null;
    if (connectedUser) log(`Connected as @${connectedUser.username} (${connectedUser.id})`);
    return;
  }

  // Nonce-based response matching (rooms.list, rooms.search, message.fetch, etc.)
  const nonce = data.nonce || data.data?.nonce;
  if (nonce && pendingRequests.has(nonce)) {
    const { resolve, timeout } = pendingRequests.get(nonce);
    clearTimeout(timeout);
    pendingRequests.delete(nonce);
    resolve(data);
    return;
  }

  // Event-type waiters (for room.active, etc.)
  for (let i = eventWaiters.length - 1; i >= 0; i--) {
    if (eventWaiters[i].type === data.type) {
      const waiter = eventWaiters.splice(i, 1)[0];
      clearTimeout(waiter.timeout);
      waiter.resolve(data);
      return;
    }
  }

  // New message — dispatch to room monitors
  if (data.type === 'message.new' || data.type === 'message.created') {
    const msg = data.data || data;
    const roomId = msg.room_id || data.room_id;

    // Skip echoes of messages WE sent via sendChatMessage (matched by nonce)
    if (data.nonce && sentNonces.has(data.nonce)) {
      sentNonces.delete(data.nonce);
      return;
    }

    const isFromSelf = connectedUser && msg.user_id === connectedUser.id;

    // Save ALL messages to history (including our own that weren't sent via nonce)
    if (saveMessageFn && roomId) {
      try {
        saveMessageFn(roomId, roomNames.get(roomId) || roomId, {
          id: msg.id || `recv_${Date.now()}`,
          user_id: msg.user_id || 'unknown',
          content: msg.content || '',
          content_type: msg.content_type || 'text',
          created_at: msg.created_at || new Date().toISOString(),
        });
      } catch {}
    }

    // Notify monitor for ALL messages (including from the user — they may be
    // replying in a Genie wish chat). The monitor callback decides what to do.
    // We tag isFromSelf so monitors can distinguish.
    if (roomId && monitors.has(roomId)) {
      try { monitors.get(roomId)({ ...data, _isFromSelf: isFromSelf }); } catch (e) { log(`Monitor error: ${e.message}`); }
    }
    return;
  }

  // Error events
  if (data.type === 'error') {
    log(`Server error: ${data.message || JSON.stringify(data)}`);
    return;
  }
}

// ─── Connection ─────────────────────────────────────────────────────────────

export function connectChat() {
  if (isDisabled()) return Promise.resolve();
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();

  intentionalClose = false;
  return new Promise((resolve, reject) => {
    const url = `${WS_URL}?auth_token=${getToken()}`;
    log('Connecting...');
    try { ws = new WebSocket(url); } catch (e) { return reject(e); }

    ws.addEventListener('open', () => {
      log('Connected');
      // Hydrate clipRooms from persistent registry so rooms survive restarts
      if (clipRooms.size === 0) {
        import('./dispatch-registry.mjs').then(reg => {
          const persisted = reg.getAllClipRooms();
          for (const [cid, rid] of persisted) clipRooms.set(cid, rid);
          if (persisted.size > 0) log(`Hydrated ${persisted.size} clip→room mappings from registry`);
        }).catch(() => {});
      }
      resolve();
    });
    ws.addEventListener('message', e => handleMessage(typeof e.data === 'string' ? e.data : String(e.data)));
    ws.addEventListener('close', e => {
      log(`Closed (${e.code})`);
      ws = null;
      for (const [, { reject, timeout }] of pendingRequests) { clearTimeout(timeout); reject(new Error('Closed')); }
      pendingRequests.clear();
      if (!intentionalClose) {
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connectChat().catch(() => {}); }, RECONNECT_DELAY_MS);
      }
    });
    ws.addEventListener('error', e => log(`Error: ${e.message || 'unknown'}`));
    setTimeout(() => { if (ws?.readyState === WebSocket.CONNECTING) { ws.close(); reject(new Error('Timeout')); } }, REQUEST_TIMEOUT_MS);
  });
}

export function disconnectChat() {
  intentionalClose = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.close(); ws = null; }
}

// ─── Room Operations ────────────────────────────────────────────────────────

// Cached DM room with Genie
let genieDirectRoomId = null;

/**
 * Get or create a group chat for a clip.
 * Reuses existing room if we already have one for this clipId.
 * Participants: logged-in user (auto) + Genie + Wobbles = 3 people = group chat.
 */
export async function createWishRoom(name, extraParticipantIds = [], clipId = null) {
  if (isDisabled()) return null;

  // Reuse existing room for this clip
  if (clipId && clipRooms.has(clipId)) {
    const existingRoomId = clipRooms.get(clipId);
    log(`Reusing room for clip ${clipId} → ${existingRoomId}`);
    return existingRoomId;
  }

  try {
    const participants = [GENIE_USER_ID, WOBBLES_USER_ID, ...extraParticipantIds];
    const promise = waitForEvent('room.active');
    send({ type: 'room.start', participant_ids: participants, name });
    const res = await promise;
    const room = res.data?.room || res.room || res.data || res;
    const roomId = room.room_id || room.id;
    if (roomId) {
      roomNames.set(roomId, name);
      if (clipId) clipRooms.set(clipId, roomId);
      log(`Created group "${name}" → ${roomId} (type: ${room.type})`);
      return roomId;
    }
    log(`No room_id in response: ${JSON.stringify(res).slice(0, 200)}`);
    return null;
  } catch (e) { log(`Create room failed: ${e.message}`); return null; }
}

/**
 * Look up existing room for a clipId.
 */
export function getRoomForClip(clipId) {
  return clipRooms.get(clipId) || null;
}

/**
 * Delete a chat room via WebSocket.
 */
export async function deleteRoom(roomId) {
  if (isDisabled()) return false;
  try {
    send({ type: 'room.delete', room_id: roomId });
    roomNames.delete(roomId);
    // Remove from clipRooms
    for (const [cid, rid] of clipRooms) { if (rid === roomId) clipRooms.delete(cid); }
    log(`Deleted room ${roomId}`);
    return true;
  } catch (e) { log(`Delete room failed: ${e.message}`); return false; }
}

/**
 * Leave a single room and wait for confirmation.
 */
function leaveRoomAsync(roomId) {
  return new Promise((resolve) => {
    const nonce = randomUUID().slice(0, 32);
    const timeout = setTimeout(() => {
      pendingRequests.delete(nonce);
      resolve(false); // timed out, still count it
    }, 5000);
    pendingRequests.set(nonce, { resolve: () => { clearTimeout(timeout); pendingRequests.delete(nonce); resolve(true); }, reject: () => { clearTimeout(timeout); resolve(false); }, timeout });
    send({ type: 'group.leave', room_id: roomId, nonce });
  });
}

/**
 * Leave all GENIE chat rooms (rooms containing Genie or Wobbles as participants).
 * Preserves the user's other non-Genie chats.
 * Sends group.leave with nonce and waits for group.left response in batches.
 */
export async function deleteAllRooms() {
  if (isDisabled()) return 0;
  let left = 0;
  let skipped = 0;
  try {
    // Keep re-listing page 1 since leaving rooms shifts the list
    for (let iteration = 0; iteration < 2000; iteration++) {
      const rooms = await listRooms(1, 50);
      if (rooms.length === 0) break;

      let foundAny = false;
      // Leave in batches of 10 with confirmation
      const batch = [];
      for (const room of rooms) {
        const rid = room.room_id || room.id;
        if (!rid) continue;
        const partIds = (room.participants || []).map(p => p.id || '');
        const isGenie = partIds.includes(GENIE_USER_ID) || partIds.includes(WOBBLES_USER_ID);
        if (isGenie) {
          batch.push(rid);
          foundAny = true;
        } else {
          skipped++;
        }
      }

      if (!foundAny) break; // no more genie rooms

      // Send leaves in parallel batches of 10
      for (let i = 0; i < batch.length; i += 10) {
        const chunk = batch.slice(i, i + 10);
        await Promise.all(chunk.map(rid => leaveRoomAsync(rid)));
        left += chunk.length;
      }

      if (left % 100 === 0 && left > 0) {
        log(`Left ${left} genie rooms so far (skipped ${skipped} others)...`);
      }
    }
    clipRooms.clear();
    log(`Left ${left} genie rooms total, kept ${skipped} other rooms`);
  } catch (e) { log(`Delete rooms failed at ${left}: ${e.message}`); }
  return left;
}

/**
 * Get or create the Genie DM (fallback for non-wish messages).
 */
export async function getGenieRoom() {
  if (isDisabled()) return null;
  if (genieDirectRoomId) return genieDirectRoomId;
  try {
    const promise = waitForEvent('room.active');
    send({ type: 'room.start', participant_ids: [GENIE_USER_ID] });
    const res = await promise;
    const room = res.data?.room || res.room || res.data || res;
    const roomId = room.room_id || room.id;
    if (roomId) { genieDirectRoomId = roomId; return roomId; }
    return null;
  } catch (e) { return null; }
}

/**
 * Search for a room by name. Response carries nonce.
 */
export async function findRoom(query) {
  if (isDisabled()) return null;
  try {
    const res = await sendWithNonce({ type: 'rooms.search', query, page: 1, page_size: 20 });
    const chats = res.data?.chats || res.chats || [];
    if (chats.length === 0) return null;
    const room = chats[0];
    log(`Found room "${room.name}" → ${room.room_id}`);
    return room.room_id;
  } catch (e) { log(`Search failed: ${e.message}`); return null; }
}

export async function findGenieRoom() { return findRoom('genie'); }

/**
 * List rooms. Response carries nonce.
 */
export async function listRooms(page = 1, pageSize = 20) {
  if (isDisabled()) return [];
  try {
    const res = await sendWithNonce({ type: 'rooms.list', page, page_size: pageSize });
    return res.data?.chats || res.chats || [];
  } catch (e) { log(`List rooms failed: ${e.message}`); return []; }
}

// ─── Messaging ──────────────────────────────────────────────────────────────

/**
 * Send a text message. message.send with nonce → server echoes nonce in new message.
 */
export async function sendChatMessage(roomId, text) {
  if (isDisabled()) return null;
  try {
    const nonce = randomUUID().slice(0, 32);
    sentNonces.add(nonce);
    send({ type: 'message.send', room_id: roomId, content: text, content_type: 'text', nonce });
    log(`Sent message to "${roomNames.get(roomId) || roomId}" (${text.length} chars)`);
    // Save to history
    if (saveMessageFn) {
      try { saveMessageFn(roomId, roomNames.get(roomId) || roomId, { id: `sent_${nonce}`, user_id: connectedUser?.id || 'self', content: text, content_type: 'text', created_at: new Date().toISOString() }); } catch {}
    }
    return true;
  } catch (e) { log(`Send failed: ${e.message}`); return null; }
}

/**
 * Send a jelly clip to a chat room.
 */
export async function sendJellyToChat(roomId, jellyId) {
  if (isDisabled()) return null;
  try {
    const nonce = randomUUID().slice(0, 32);
    sentNonces.add(nonce);
    send({ type: 'message.send', room_id: roomId, content: jellyId, content_type: 'jelly', nonce });
    log(`Sent jelly ${jellyId} to "${roomNames.get(roomId) || roomId}"`);
    return true;
  } catch (e) { log(`Send jelly failed: ${e.message}`); return null; }
}

/**
 * Fetch message history for a room.
 */
export async function fetchChatMessages(roomId, limit = 50) {
  if (isDisabled()) return [];
  try {
    // message.fetch → server responds with message.history (no nonce)
    const promise = waitForEvent('message.history');
    send({ type: 'message.fetch', room_id: roomId, limit });
    const res = await promise;
    return res.data?.messages || [];
  } catch (e) { log(`Fetch messages failed: ${e.message}`); return []; }
}

// ─── Monitoring ─────────────────────────────────────────────────────────────

export function monitorChat(roomId, callback) {
  if (isDisabled()) return () => {};
  log(`Monitoring room "${roomNames.get(roomId) || roomId}"`);
  monitors.set(roomId, callback);
  return () => { monitors.delete(roomId); };
}

// ─── Exports for external use ───────────────────────────────────────────────
export { connectedUser, GENIE_USER_ID };
