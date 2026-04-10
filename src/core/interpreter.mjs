#!/usr/bin/env node
// Transcript Interpreter
// Takes raw Deepgram transcript -> produces structured proposal JSON
// Uses OpenRouter (Claude Sonnet) or any OpenRouter-compatible model
// Exports: interpretTranscript(transcript, creator)

import { INTERPRETER_SYSTEM } from '../../config/prompts.mjs';

/**
 * Interpret a JellyJelly transcript and produce a structured proposal.
 * @param {string} transcript - Raw transcript text
 * @param {object} creator - Creator metadata { username, displayName, bio }
 * @returns {Promise<object>} Structured proposal JSON
 */
export async function interpretTranscript(transcript, creator = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-6';

  if (!apiKey) {
    throw new Error('[INTERPRETER] OPENROUTER_API_KEY not set');
  }

  if (!transcript || transcript.trim().length === 0) {
    return {
      title: 'Empty transcript',
      summary: 'Nothing actionable detected',
      wishes: [],
      strategy: { recommendation: 'Record a clearer clip', proactiveActions: [] },
      ignored: ['entire transcript'],
    };
  }

  // Build user message with creator context
  const creatorContext = creator.username
    ? `\n\nCreator: @${creator.username}${creator.displayName ? ` (${creator.displayName})` : ''}${creator.bio ? `\nBio: ${creator.bio}` : ''}`
    : '';

  const userMessage = `Transcript:\n"${transcript}"${creatorContext}`;

  console.log(`[INTERPRETER] Calling ${model} via OpenRouter...`);
  console.log(`[INTERPRETER] Transcript length: ${transcript.length} chars`);

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/gtrush03/genie',
      'X-Title': 'Genie Wish Engine',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: INTERPRETER_SYSTEM },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`[INTERPRETER] OpenRouter ${res.status}: ${errBody}`);
  }

  const data = await res.json();

  // Extract the content from the response
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('[INTERPRETER] No content in LLM response');
  }

  console.log(`[INTERPRETER] Got response (${content.length} chars)`);

  // Parse JSON — handle raw JSON or markdown-fenced JSON
  const proposal = parseJsonFromLLM(content);

  // Validate minimum structure
  if (!proposal.wishes) {
    proposal.wishes = [];
  }
  if (!proposal.strategy) {
    proposal.strategy = { recommendation: '', proactiveActions: [] };
  }
  if (!proposal.title) {
    proposal.title = 'Untitled Proposal';
  }
  if (!proposal.summary) {
    proposal.summary = '';
  }

  console.log(`[INTERPRETER] Extracted ${proposal.wishes.length} wishes`);
  return proposal;
}

/**
 * Parse JSON from LLM output, handling markdown fences and preamble text.
 * @param {string} raw - Raw LLM output
 * @returns {object} Parsed JSON
 */
function parseJsonFromLLM(raw) {
  const trimmed = raw.trim();

  // Try direct parse first
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // fall through
  }

  // Try extracting from markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch (_) {
      // fall through
    }
  }

  // Try finding JSON object by matching first { to last }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch (_) {
      // fall through
    }
  }

  throw new Error(`[INTERPRETER] Could not parse JSON from LLM output:\n${trimmed.slice(0, 500)}`);
}
