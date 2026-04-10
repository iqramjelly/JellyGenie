#!/usr/bin/env node
// Site Builder
// Takes wish spec -> generates HTML from Tailwind template -> writes to /tmp/genie/
// Template interpolation for speed, LLM fallback for complex requests
// Fetches real images from Unsplash Source for hero + feature cards
// Usage: import { buildSite } from './build-site.mjs'

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', 'templates', 'landing.html');

const FEATURE_ICONS = ['&#9889;', '&#128640;', '&#127912;', '&#9733;', '&#128161;', '&#128279;', '&#127919;', '&#128200;', '&#128736;'];

/**
 * Extract 2-3 keywords from name + tagline for image search.
 */
function extractKeywords(name, tagline) {
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'of', 'in', 'to', 'for',
    'with', 'on', 'at', 'by', 'from', 'up', 'about', 'into', 'through',
    'during', 'before', 'after', 'and', 'but', 'or', 'not', 'no', 'so',
    'if', 'than', 'too', 'very', 'just', 'that', 'this', 'it', 'its',
    'your', 'our', 'my', 'their', 'we', 'you', 'they', 'all', 'each',
    'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
    'what', 'which', 'who', 'when', 'where', 'why', 'how', 'something',
    'amazing', 'coming', 'get', 'started', 'ready', 'join', 'now',
  ]);

  const combined = `${name} ${tagline}`.toLowerCase();
  const words = combined.match(/[a-z]{3,}/g) || [];
  const unique = [...new Set(words)].filter(w => !stopwords.has(w));
  return unique.slice(0, 3);
}

/**
 * Generate Unsplash Source URLs for hero and feature images.
 */
function getImageUrls(name, tagline) {
  const keywords = extractKeywords(name, tagline);
  const kw = keywords.length > 0 ? keywords.join(',') : 'technology,modern';

  const heroUrl = `https://source.unsplash.com/featured/1200x600/?${encodeURIComponent(kw)}`;

  // Per-feature images use individual keywords for variety
  const featureUrls = keywords.map((keyword, i) =>
    `https://source.unsplash.com/featured/600x400/?${encodeURIComponent(keyword)}&sig=${i}`
  );

  // Ensure at least 3 feature URLs
  while (featureUrls.length < 3) {
    featureUrls.push(`https://source.unsplash.com/featured/600x400/?${encodeURIComponent(kw)}&sig=${featureUrls.length}`);
  }

  return { heroUrl, featureUrls };
}

/**
 * Build a landing page from a wish spec.
 * @param {object} spec
 * @param {string} spec.name - Project/event name
 * @param {string} spec.tagline - One-liner description
 * @param {string[]} spec.features - List of features/highlights
 * @param {object} [spec.colors] - { primary, accent }
 * @param {string} [spec.creatorName] - Creator's display name
 * @param {string} [spec.date] - Event date
 * @param {string} [spec.location] - Event location
 * @param {string} [spec.ctaText] - Custom CTA text
 * @param {string} [spec.statusBadge] - Badge text (e.g. "Coming Soon")
 * @returns {{ dir: string, files: string[] }}
 */
export function buildSite(spec) {
  const {
    name = 'Untitled',
    tagline = 'Something amazing is coming.',
    features = [],
    colors = {},
    creatorName = '',
    date = '',
    location = '',
    ctaText = '',
    statusBadge = '',
  } = spec;

  const accentColor = colors?.primary || colors?.accent || '#8b5cf6';
  const glowColor = colors?.accent || colors?.glow || '#ec4899';

  // Generate image URLs from Unsplash Source
  const { heroUrl, featureUrls } = getImageUrls(name, tagline);

  // Generate slug
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const timestamp = Date.now();
  const dir = `/tmp/genie/genie-${slug}-${timestamp}`;

  // Read template
  let html;
  try {
    html = readFileSync(TEMPLATE_PATH, 'utf-8');
  } catch (_) {
    // Fallback: use inline template if file read fails
    console.warn('[BUILD-SITE] Could not read template file, using inline fallback');
    html = getInlineTemplate();
  }

  // Build features HTML with images
  const featuresHtml = features.length > 0
    ? features.map((feat, i) => {
        const icon = FEATURE_ICONS[i % FEATURE_ICONS.length];
        const featureTitle = typeof feat === 'string' ? feat : feat.title || feat.name || 'Feature';
        const featureDesc = typeof feat === 'object' && feat.description ? feat.description : '';
        const imgUrl = featureUrls[i % featureUrls.length];
        return `
        <div class="glass rounded-2xl p-6 hover:bg-white/[0.04] transition-all group feature-card overflow-hidden">
          <img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(featureTitle)}" class="feature-img" loading="lazy">
          <div class="feature-icon">${icon}</div>
          <h3 class="text-lg font-semibold mb-2 group-hover:text-white transition-colors">${escapeHtml(featureTitle)}</h3>
          <p class="text-white/40 text-sm leading-relaxed">${escapeHtml(featureDesc || featureTitle)}</p>
        </div>`;
      }).join('\n')
    : `
        <div class="glass rounded-2xl p-8 col-span-full text-center">
          <p class="text-white/40">Details coming soon.</p>
        </div>`;

  // Build event section (only if date or location provided)
  let eventSection = '';
  if (date || location) {
    eventSection = `
  <section id="details" class="py-24 px-6">
    <div class="max-w-4xl mx-auto">
      <div class="glass-strong rounded-3xl p-12 glow-border">
        <h2 class="text-3xl font-bold mb-8 text-center">Event Details</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-8">
          ${date ? `
          <div class="text-center">
            <div class="text-white/30 text-sm uppercase tracking-wider mb-2">When</div>
            <div class="text-2xl font-semibold">${escapeHtml(date)}</div>
          </div>` : ''}
          ${location ? `
          <div class="text-center">
            <div class="text-white/30 text-sm uppercase tracking-wider mb-2">Where</div>
            <div class="text-2xl font-semibold">${escapeHtml(location)}</div>
          </div>` : ''}
        </div>
      </div>
    </div>
  </section>`;
  }

  // Interpolate
  html = html
    .replace(/\{\{NAME\}\}/g, escapeHtml(name))
    .replace(/\{\{TAGLINE\}\}/g, escapeHtml(tagline))
    .replace(/\{\{ACCENT_COLOR\}\}/g, accentColor)
    .replace(/\{\{GLOW_COLOR\}\}/g, glowColor)
    .replace(/\{\{HERO_IMAGE_URL\}\}/g, heroUrl)
    .replace(/\{\{FEATURES_HTML\}\}/g, featuresHtml)
    .replace(/\{\{EVENT_SECTION\}\}/g, eventSection)
    .replace(/\{\{STATUS_BADGE\}\}/g, escapeHtml(statusBadge || 'Just launched'))
    .replace(/\{\{CTA_TEXT\}\}/g, escapeHtml(ctaText || `Join the ${name} movement.`))
    .replace(/\{\{CREATOR_LINE\}\}/g, creatorName ? `Created by ${escapeHtml(creatorName)}` : '');

  // Write output
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, 'index.html');
  writeFileSync(outputPath, html, 'utf-8');

  console.log(`[BUILD-SITE] Generated: ${outputPath}`);
  console.log(`[BUILD-SITE] Features: ${features.length}, Hero: ${heroUrl}`);
  console.log(`[BUILD-SITE] Keywords: ${extractKeywords(name, tagline).join(', ')}`);

  return { dir, files: ['index.html'] };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getInlineTemplate() {
  // Minimal inline fallback — same structure as landing.html but self-contained
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{NAME}}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1FA94}</text></svg>">
  <meta property="og:title" content="{{NAME}}">
  <meta property="og:description" content="{{TAGLINE}}">
  <meta property="og:image" content="{{HERO_IMAGE_URL}}">
  <meta property="og:type" content="website">
  <script src="https://cdn.tailwindcss.com"><\/script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
    * { font-family: 'Inter', system-ui, sans-serif; }
    html { scroll-behavior: smooth; }
    body { background: #0a0a0a; }
    .glass { background: rgba(255,255,255,0.03); backdrop-filter: blur(40px); border: 1px solid rgba(255,255,255,0.06); }
    .glass-strong { background: rgba(255,255,255,0.05); backdrop-filter: blur(60px); border: 1px solid rgba(255,255,255,0.08); }
    .glow-border { border: 1px solid rgba(139,92,246,0.3); box-shadow: 0 0 30px -10px rgba(139,92,246,0.2); }
    .gradient-text { background: linear-gradient(135deg, {{ACCENT_COLOR}}, {{GLOW_COLOR}}); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .hero-section { background-image: linear-gradient(to bottom, rgba(10,10,10,0.4), rgba(10,10,10,0.85) 70%, #0a0a0a), url('{{HERO_IMAGE_URL}}'); background-size: cover; background-position: center; }
    .cta-btn { background: linear-gradient(135deg, {{ACCENT_COLOR}}, {{GLOW_COLOR}}); transition: all 0.3s; box-shadow: 0 0 40px -10px {{ACCENT_COLOR}}; }
    .cta-btn:hover { transform: translateY(-2px); box-shadow: 0 0 60px -10px {{ACCENT_COLOR}}; }
    .feature-icon { width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,rgba(139,92,246,0.15),rgba(236,72,153,0.15));display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:16px; }
    .feature-img { width:100%;height:160px;object-fit:cover;border-radius:12px;margin-bottom:16px;opacity:0.85; }
    .genie-badge { display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,rgba(139,92,246,0.15),rgba(236,72,153,0.1));border:1px solid rgba(139,92,246,0.2);border-radius:999px;padding:4px 14px;font-size:12px;color:rgba(255,255,255,0.5); }
    .fade-in { animation: fadeIn 0.8s ease-out forwards; opacity: 0; }
    @keyframes fadeIn { to { opacity: 1; } }
  </style>
</head>
<body class="bg-[#0a0a0a] text-white min-h-screen antialiased">
  <nav class="fixed top-0 left-0 right-0 z-50 glass border-b border-white/5">
    <div class="max-w-6xl mx-auto flex items-center justify-between px-6 py-3">
      <a href="#" class="font-bold text-lg gradient-text">{{NAME}}</a>
      <div class="flex items-center gap-6 text-sm text-white/50">
        <a href="#features" class="hover:text-white transition-colors">Features</a>
        <a href="#signup" class="hover:text-white transition-colors">Sign Up</a>
      </div>
    </div>
  </nav>
  <section class="hero-section min-h-[85vh] flex items-center justify-center px-6 relative">
    <div class="relative z-10 text-center max-w-4xl mx-auto fade-in" style="padding-top:60px">
      <div class="inline-flex items-center gap-2 glass rounded-full px-4 py-2 text-sm text-white/60 mb-8">
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        {{STATUS_BADGE}}
      </div>
      <h1 class="text-5xl sm:text-7xl font-black mb-6"><span class="gradient-text">{{NAME}}</span></h1>
      <p class="text-xl text-white/60 font-light max-w-2xl mx-auto mb-10">{{TAGLINE}}</p>
      <a href="#signup" class="cta-btn text-white font-semibold px-8 py-4 rounded-2xl text-lg inline-block">Get Started</a>
    </div>
  </section>
  <section id="features" class="py-24 px-6">
    <div class="max-w-6xl mx-auto">
      <div class="text-center mb-16">
        <h2 class="text-3xl font-bold mb-4">What's Inside</h2>
        <p class="text-white/40 text-lg">Everything you need, nothing you don't.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">{{FEATURES_HTML}}</div>
    </div>
  </section>
  {{EVENT_SECTION}}
  <section id="signup" class="py-24 px-6">
    <div class="max-w-3xl mx-auto text-center">
      <div class="glass-strong rounded-3xl p-12 glow-border">
        <h2 class="text-3xl font-bold mb-4 gradient-text">Ready?</h2>
        <p class="text-white/40 text-lg mb-8">{{CTA_TEXT}}</p>
        <form onsubmit="event.preventDefault();this.querySelector('button').textContent='You are in! \\u2728';this.querySelector('input').disabled=true;this.querySelector('button').disabled=true;" class="flex flex-col sm:flex-row gap-3 max-w-lg mx-auto">
          <input type="email" placeholder="you@email.com" required class="flex-1 bg-white/5 border border-white/10 rounded-xl px-5 py-3 text-white placeholder-white/30 outline-none focus:border-white/20">
          <button type="submit" class="cta-btn text-white font-semibold px-8 py-3 rounded-xl">Join Now</button>
        </form>
      </div>
    </div>
  </section>
  <footer class="border-t border-white/5 py-8 px-6 text-center">
    <div class="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
      <span class="text-white/20 text-sm">{{CREATOR_LINE}}</span>
      <span class="genie-badge">Built by Genie &#129518; from a JellyJelly video</span>
    </div>
  </footer>
</body>
</html>`;
}

// CLI mode
if (process.argv[1] && process.argv[1].endsWith('build-site.mjs') && process.argv.includes('--name')) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const name = getArg('--name') || 'Test Site';
  const tagline = getArg('--tagline') || 'A test landing page';
  let features = [];
  const featuresRaw = getArg('--features');
  if (featuresRaw) {
    try { features = JSON.parse(featuresRaw); } catch (_) { features = [featuresRaw]; }
  }

  const result = buildSite({
    name,
    tagline,
    features,
    date: getArg('--date'),
    location: getArg('--location'),
    creatorName: getArg('--creator'),
  });

  console.log(JSON.stringify(result, null, 2));
}
