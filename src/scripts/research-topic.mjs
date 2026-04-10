#!/usr/bin/env node
// Topic Researcher
// Uses Perplexity Sonar (via OpenRouter) to fetch real, live, web-grounded facts
// about a topic before Genie builds a site from it. Returns structured JSON.
// Usage: import { researchTopic } from './research-topic.mjs'

const RESEARCH_MODEL = process.env.GENIE_RESEARCH_MODEL || 'perplexity/sonar-pro';

function log(msg) {
  console.log(`[RESEARCH-TOPIC] ${msg}`);
}

/**
 * Fetch real, live facts about a topic from the web.
 * @param {string} query - The thing to research (e.g. "NYC Auto Show at Javits Center 2026")
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @returns {Promise<{
 *   summary: string,
 *   facts: Array<{ label: string, value: string }>,
 *   features: Array<{ title: string, description: string }>,
 *   sources: string[],
 *   raw: string,
 * }>}
 */
export async function researchTopic(query, opts = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    log('OPENROUTER_API_KEY not set — skipping research');
    return { summary: '', facts: [], features: [], sources: [], raw: '' };
  }

  if (!query || !query.trim()) {
    return { summary: '', facts: [], features: [], sources: [], raw: '' };
  }

  const systemPrompt = `You are a research assistant that returns ONLY valid JSON — no prose, no markdown fences, no preamble.
Use live web search to find current, factual information. Prefer official sources.
Return this exact schema:
{
  "summary": "2-3 sentence factual summary of the topic based on what you actually found online",
  "facts": [{"label": "Dates", "value": "March 28 – April 6, 2026"}, {"label": "Location", "value": "..."}, ...],
  "features": [{"title": "short card title", "description": "1-2 sentence factual detail for a landing page"}],
  "sources": ["https://...", "https://..."]
}
Rules:
- facts: 4-8 concrete data points (dates, addresses, prices, names, numbers). Must come from your web search, not guesses.
- features: 4-8 landing-page-ready bullet points. Each must contain a real fact (who, what, when, where, how much).
- sources: list the actual URLs you used. At least 2.
- If a fact is unknown or unverified, omit it. Do not hallucinate. Do not invent URLs.`;

  log(`Querying ${RESEARCH_MODEL} for: ${query.slice(0, 120)}`);
  const t0 = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 30_000);

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/gtrush03/genie',
        'X-Title': 'Genie Topic Research',
      },
      body: JSON.stringify({
        model: RESEARCH_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Research this for a landing page and return JSON only:\n\n${query}` },
        ],
        temperature: 0.1,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = parseJson(content);

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    log(`Got ${parsed.facts?.length || 0} facts, ${parsed.features?.length || 0} features, ${parsed.sources?.length || 0} sources in ${dt}s`);

    return {
      summary: parsed.summary || '',
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      features: Array.isArray(parsed.features) ? parsed.features : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      raw: content,
    };
  } catch (err) {
    log(`Failed: ${err.message}`);
    return { summary: '', facts: [], features: [], sources: [], raw: '', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(raw) {
  const trimmed = (raw || '').trim();
  try { return JSON.parse(trimmed); } catch (_) {}
  const fence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch (_) {} }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch (_) {}
  }
  return {};
}

// CLI mode for testing
if (process.argv[1] && process.argv[1].endsWith('research-topic.mjs')) {
  const query = process.argv.slice(2).join(' ');
  if (!query) {
    console.error('Usage: node research-topic.mjs <topic>');
    process.exit(1);
  }
  researchTopic(query).then(r => {
    console.log(JSON.stringify(r, null, 2));
  });
}
