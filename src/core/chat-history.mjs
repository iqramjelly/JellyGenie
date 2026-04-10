// Genie — Chat History Storage
// Stores all JellyJelly chat messages (from wish rooms) in a local history file.
// Like Dropbox's activity log — persistent, searchable, paginated.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

// ─── Configuration ──────────────────────────────────────────────────────────
const GENIE_DIR = resolve(homedir(), '.genie');
const HISTORY_PATH = resolve(GENIE_DIR, 'chat-history.json');
const MAX_MESSAGES = 10_000;

// ─── Logging ────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[GENIE] [HISTORY] ${msg}`);
}

// ─── Storage helpers ────────────────────────────────────────────────────────

function ensureDir() {
  if (!existsSync(GENIE_DIR)) {
    mkdirSync(GENIE_DIR, { recursive: true });
  }
}

function loadHistory() {
  ensureDir();
  if (!existsSync(HISTORY_PATH)) {
    return { rooms: {}, messages: [] };
  }
  try {
    const raw = readFileSync(HISTORY_PATH, 'utf-8');
    const data = JSON.parse(raw);
    // Ensure expected shape
    if (!data.rooms || !Array.isArray(data.messages)) {
      return { rooms: data.rooms || {}, messages: Array.isArray(data.messages) ? data.messages : [] };
    }
    return data;
  } catch (err) {
    log(`Failed to read history: ${err.message}`);
    return { rooms: {}, messages: [] };
  }
}

function saveHistory(data) {
  ensureDir();
  try {
    // Trim oldest messages if over cap
    if (data.messages.length > MAX_MESSAGES) {
      const removed = data.messages.length - MAX_MESSAGES;
      data.messages = data.messages.slice(0, MAX_MESSAGES);
      log(`Trimmed ${removed} oldest messages (cap=${MAX_MESSAGES})`);
    }
    writeFileSync(HISTORY_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    log(`Failed to write history: ${err.message}`);
  }
}

// ─── Exported functions ─────────────────────────────────────────────────────

/**
 * Save a chat message to history.
 * @param {string} roomId - The room/chat ID
 * @param {string} roomName - Human-readable room name
 * @param {object} message - Message object with: id, user_id, content, content_type, created_at
 */
export function saveMessage(roomId, roomName, message) {
  try {
    const history = loadHistory();

    // Ensure room entry exists
    if (!history.rooms[roomId]) {
      history.rooms[roomId] = {
        name: roomName || 'Unknown Room',
        createdAt: new Date().toISOString(),
        jellyId: null,
        wishSuccess: null,
        wishCost: null,
        messageCount: 0,
      };
    } else if (roomName && roomName !== roomId && history.rooms[roomId].name === roomId) {
      // Update room name if we now have the actual title instead of a clip ID
      history.rooms[roomId].name = roomName;
    }

    // Build normalized message record
    const record = {
      id: message.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      roomId,
      userId: message.user_id || message.userId || 'unknown',
      content: message.content || '',
      contentType: message.content_type || message.contentType || 'text',
      timestamp: message.created_at || message.createdAt || new Date().toISOString(),
      isWishResult: false,
    };

    // Deduplicate by message id
    const exists = history.messages.some(m => m.id === record.id);
    if (exists) {
      return;
    }

    // Insert at beginning (newest first)
    history.messages.unshift(record);

    // Update room message count
    history.rooms[roomId].messageCount = history.messages.filter(m => m.roomId === roomId).length;

    saveHistory(history);
    log(`Saved message ${record.id} in room "${roomName || roomId}"`);
  } catch (err) {
    log(`Error saving message: ${err.message}`);
  }
}

/**
 * Save a wish completion event to history.
 * @param {string} roomId - The room/chat ID
 * @param {string} roomName - Human-readable room name
 * @param {object} wishResult - Object with: success, cost, turns, duration, transcript, result
 */
export function saveWishResult(roomId, roomName, wishResult) {
  try {
    const history = loadHistory();

    // Ensure room entry exists
    if (!history.rooms[roomId]) {
      history.rooms[roomId] = {
        name: roomName || 'Unknown Room',
        createdAt: new Date().toISOString(),
        jellyId: null,
        wishSuccess: null,
        wishCost: null,
        messageCount: 0,
      };
    } else if (roomName && roomName !== roomId && history.rooms[roomId].name === roomId) {
      // Update room name if we now have the actual title instead of a clip ID
      history.rooms[roomId].name = roomName;
    }

    // Update room with wish result metadata
    history.rooms[roomId].wishSuccess = wishResult.success ?? null;
    history.rooms[roomId].wishCost = wishResult.cost ?? wishResult.usdCost ?? null;

    // Create a wish-result message record
    const durationStr = wishResult.duration
      ? `${(wishResult.duration / 1000).toFixed(1)}s`
      : wishResult.durationMs
        ? `${(wishResult.durationMs / 1000).toFixed(1)}s`
        : '?';
    const costStr = (wishResult.cost ?? wishResult.usdCost ?? 0).toFixed(3);
    const statusEmoji = wishResult.success ? 'SUCCESS' : 'FAILED';

    let content = `[WISH ${statusEmoji}] Cost: $${costStr} | Turns: ${wishResult.turns ?? '?'} | Duration: ${durationStr}`;
    if (wishResult.result) {
      const preview = wishResult.result.length > 500 ? wishResult.result.slice(0, 500) + '...' : wishResult.result;
      content += `\n\n${preview}`;
    }

    const record = {
      id: `wish_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      roomId,
      userId: 'genie-system',
      content,
      contentType: 'wish_result',
      timestamp: new Date().toISOString(),
      isWishResult: true,
    };

    history.messages.unshift(record);
    history.rooms[roomId].messageCount = history.messages.filter(m => m.roomId === roomId).length;

    saveHistory(history);
    log(`Saved wish result for room "${roomName || roomId}": ${statusEmoji}, $${costStr}`);
  } catch (err) {
    log(`Error saving wish result: ${err.message}`);
  }
}

/**
 * Get paginated message history.
 * @param {object} [options]
 * @param {number} [options.page=1] - Page number (1-based)
 * @param {number} [options.pageSize=50] - Messages per page
 * @param {string} [options.roomId] - Optional room filter
 * @returns {{ messages: Array, page: number, pageSize: number, totalMessages: number, totalPages: number }}
 */
export function getHistory(options = {}) {
  const { page = 1, pageSize = 50, roomId } = options;

  const history = loadHistory();
  let msgs = history.messages;

  if (roomId) {
    msgs = msgs.filter(m => m.roomId === roomId);
  }

  const totalMessages = msgs.length;
  const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * pageSize;
  const slice = msgs.slice(start, start + pageSize);

  return {
    messages: slice,
    page: safePage,
    pageSize,
    totalMessages,
    totalPages,
  };
}

/**
 * Get list of all rooms with their metadata and message counts.
 * @returns {Array<{ roomId: string, name: string, createdAt: string, jellyId: string|null, wishSuccess: boolean|null, wishCost: number|null, messageCount: number }>}
 */
export function getRooms() {
  const history = loadHistory();
  return Object.entries(history.rooms).map(([roomId, room]) => ({
    roomId,
    name: room.name,
    createdAt: room.createdAt,
    jellyId: room.jellyId || null,
    wishSuccess: room.wishSuccess,
    wishCost: room.wishCost,
    messageCount: room.messageCount || 0,
  }));
}

/**
 * Full-text search across all messages.
 * @param {string} query - Search query (case-insensitive)
 * @returns {Array} Matching messages
 */
export function searchHistory(query) {
  if (!query || typeof query !== 'string') return [];

  const history = loadHistory();
  const lower = query.toLowerCase();

  const results = history.messages.filter(m => {
    if (m.content && m.content.toLowerCase().includes(lower)) return true;
    // Also search room names
    const room = history.rooms[m.roomId];
    if (room && room.name && room.name.toLowerCase().includes(lower)) return true;
    return false;
  });

  log(`Search "${query}" returned ${results.length} results`);
  return results;
}

/**
 * Clear all chat history — removes all rooms and messages.
 * @returns {{ roomsCleared: number, messagesCleared: number }}
 */
export function clearHistory() {
  const history = loadHistory();
  const roomsCleared = Object.keys(history.rooms).length;
  const messagesCleared = history.messages.length;
  saveHistory({ rooms: {}, messages: [] });
  log(`Cleared ${roomsCleared} rooms, ${messagesCleared} messages`);
  return { roomsCleared, messagesCleared };
}
