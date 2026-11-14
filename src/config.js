'use strict';

// User config lives in the addon URL (Stremio convention), base64url-encoded JSON:
//   https://your-host/<config>/manifest.json

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

const DEFAULTS = {
  key: '', // Gemini API key (or empty when the server has GEMINI_API_KEY)
  pass: '', // password for server-key mode (ADDON_PASSWORD)
  lang: 'tur', // target language (ISO 639-2)
  model: DEFAULT_MODEL,
  src: ['eng'], // source languages to translate from, in priority order
  max: 2, // how many translated options to list per video
};

function encodeConfig(cfg) {
  return Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64url');
}

function sanitize(raw) {
  const cfg = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return cfg;
  if (typeof raw.key === 'string') cfg.key = raw.key.trim().slice(0, 200);
  if (typeof raw.pass === 'string') cfg.pass = raw.pass.slice(0, 200);
  if (typeof raw.lang === 'string' && /^[a-z]{2,3}$/.test(raw.lang)) cfg.lang = raw.lang;
  if (typeof raw.model === 'string' && /^[a-zA-Z0-9.\-_]{3,80}$/.test(raw.model)) cfg.model = raw.model;
  let src = raw.src;
  if (typeof src === 'string') src = src.split(',');
  if (Array.isArray(src)) {
    const list = src.map((s) => String(s).trim().toLowerCase()).filter((s) => /^[a-z]{2,3}$/.test(s));
    if (list.length) cfg.src = list.slice(0, 5);
  }
  const max = parseInt(raw.max, 10);
  if (max >= 1 && max <= 5) cfg.max = max;
  return cfg;
}

function decodeConfig(str) {
  if (!str) return null;
  try {
    return sanitize(JSON.parse(Buffer.from(str, 'base64url').toString('utf8')));
  } catch (_) {
    try {
      // Also accept plain URL-encoded JSON, as some Stremio addons do.
      return sanitize(JSON.parse(decodeURIComponent(str)));
    } catch (__) {
      return null;
    }
  }
}

module.exports = { DEFAULTS, DEFAULT_MODEL, encodeConfig, decodeConfig, sanitize };
