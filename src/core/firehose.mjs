#!/usr/bin/env node
// JellyJelly Firehose Scanner
// Polls GET /v3/jelly (authenticated) to list own jellies (all privacy levels).
// Falls back to /v3/jelly/search (public only) when no auth token is set.
// Exports: pollForNewClips(), fetchClipDetail(), containsKeyword()

const API_BASE = process.env.JELLY_API_URL || 'https://api.jellyjelly.com/v3';

function getAuthHeaders() {
  const token = process.env.JELLY_AUTH_TOKEN;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Poll for new jellies. When authenticated, uses GET /v3/jelly which returns
 * ALL of the user's jellies (public, unlisted, private). When unauthenticated,
 * falls back to GET /v3/jelly/search (public only).
 *
 * @param {object} [options]
 * @param {number} [options.pageSize=50]
 * @returns {Promise<{clips: object[]}>}
 */
export async function pollForNewClips(options = {}) {
  const pageSize = options.pageSize || 50;
  const auth = getAuthHeaders();
  const hasAuth = !!auth.Authorization;

  let clips;

  if (hasAuth) {
    // Authenticated: GET /v3/jelly returns own jellies (all privacy levels)
    const params = new URLSearchParams({ page_size: String(pageSize) });
    const url = `${API_BASE}/jelly?${params}`;
    const res = await fetch(url, { headers: auth });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`JellyJelly list failed: ${res.status} ${res.statusText} — ${body}`);
    }
    const data = await res.json();
    // Response: { jellies: [ { id, title, transcript_overlay, ... }, ... ] }
    // Each entry may or may not be wrapped in { jelly: {...} } — unwrap if needed.
    const rawJellies = data.jellies || [];
    clips = rawJellies.map(j => j.jelly || j);
  } else {
    // Unauthenticated fallback: search (public only)
    const params = new URLSearchParams({
      ascending: 'false',
      page_size: String(pageSize),
    });
    const url = `${API_BASE}/jelly/search?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`JellyJelly search failed: ${res.status} ${res.statusText} — ${body}`);
    }
    const data = await res.json();
    clips = data.jellies || data.results || data.items || (Array.isArray(data) ? data : []);
  }

  return { clips };
}

/**
 * Fetch full detail for a single jelly.
 * Uses auth token if available (needed for unlisted/private jellies).
 * @param {string} clipId - The jelly ULID/ID
 * @returns {Promise<object>} Full jelly data with reconstructed transcript
 */
export async function fetchClipDetail(clipId) {
  const url = `${API_BASE}/jelly/${clipId}`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`JellyJelly detail failed for ${clipId}: ${res.status} ${res.statusText} — ${body}`);
  }

  const data = await res.json();
  const clip = data.jelly || data;

  // Reconstruct transcript from transcript_overlay if present
  clip._transcript = reconstructTranscript(clip.transcript_overlay);

  return clip;
}

/**
 * Reconstruct a plain-text transcript from transcript_overlay data.
 */
export function reconstructTranscript(transcriptOverlay) {
  if (!transcriptOverlay) return '';

  try {
    const results = transcriptOverlay.results;
    if (!results || !results.channels || !results.channels[0]) return '';

    const channel = results.channels[0];
    if (!channel.alternatives || !channel.alternatives[0]) return '';

    const words = channel.alternatives[0].words;
    if (!Array.isArray(words) || words.length === 0) return '';

    return words.map(w => w.punctuated_word || w.word || '').join(' ');
  } catch (e) {
    return '';
  }
}

/**
 * Check if a keyword appears in the transcript word-level data.
 * Scans both `word` and `punctuated_word` fields, case-insensitive.
 * Includes common speech-to-text misheard variants of "genie".
 */
// Speech-to-text often mishears "genie" as these variants
const KEYWORD_VARIANTS = ['genie', 'jeanie', 'jeannie', 'jenie', 'genee', 'jelly', 'jellie', 'jinni', 'jennie', 'jenny'];

export function containsKeyword(transcriptOverlay, keyword) {
  if (!transcriptOverlay || !keyword) return false;

  const target = keyword.toLowerCase();
  const variants = target === 'genie' ? KEYWORD_VARIANTS : [target];

  try {
    const results = transcriptOverlay.results;
    if (!results || !results.channels) return false;

    for (const channel of results.channels) {
      if (!channel.alternatives) continue;
      for (const alt of channel.alternatives) {
        if (!alt.words) continue;
        for (const w of alt.words) {
          if (w.word) {
            const lower = w.word.toLowerCase();
            if (variants.includes(lower)) return true;
          }
          if (w.punctuated_word) {
            const cleaned = w.punctuated_word.replace(/[.,!?;:'"]+$/g, '').toLowerCase();
            if (variants.includes(cleaned)) return true;
          }
        }
      }
    }
  } catch (e) {
    return false;
  }

  return false;
}

/**
 * Count words in transcript overlay.
 */
export function transcriptWordCount(overlay) {
  try {
    const words = overlay?.results?.channels?.[0]?.alternatives?.[0]?.words;
    return Array.isArray(words) ? words.length : 0;
  } catch {
    return 0;
  }
}
