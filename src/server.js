'use strict';

const http = require('http');
const { parseExtra, rankForSync } = require('./match');
const crypto = require('crypto');
const { parseSrt, serializeSrt } = require('./srt');
const { translateTexts, buildNotes } = require('./translator');
const { decodeConfig, encodeConfig, DEFAULT_MODEL } = require('./config');
const { languageName, LANGUAGES } = require('./languages');
const { Cache } = require('./cache');
const { configurePage } = require('./configure');
const { styleInstructions } = require('./styles');
const pkg = require('../package.json');

const PORT = parseInt(process.env.PORT, 10) || 7000;
const SUBTITLE_SOURCE = (process.env.SUBTITLE_SOURCE || 'https://opensubtitles-v3.strem.io').replace(/\/$/, '');
// Only download subtitle files from these hosts (stops the addon being used as an open proxy).
const ALLOWED_SUB_HOSTS = (process.env.ALLOWED_SUB_HOSTS || 'strem.io').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const WAIT_MS = parseInt(process.env.TRANSLATE_WAIT_MS, 10) || 100000;
const PREWARM = process.env.PREWARM !== 'false';
const SERVER_KEY = process.env.GEMINI_API_KEY || '';
const ADDON_PASSWORD = process.env.ADDON_PASSWORD || '';
// With GEMINI_API_KEY set and no ADDON_PASSWORD, the short link (no settings in the URL) uses default settings.
const SHORT_LINK_CFG = encodeConfig({});
// Batches sent at once per translation. The per-key pacer in translator.js keeps this within the free-tier rate.
// Model for the quick read of the whole episode before translating (GEMINI_NOTES_MODEL=off disables it).
const NOTES_MODEL = /^(off|0|false)$/i.test(process.env.GEMINI_NOTES_MODEL || '') ? '' : (process.env.GEMINI_NOTES_MODEL || 'gemini-3.5-flash-lite').trim();
const NOTES_WAIT_MS = parseInt(process.env.GEMINI_NOTES_WAIT_MS, 10) || 25000;
const CONCURRENCY = parseInt(process.env.GEMINI_CONCURRENCY, 10) || 3;
const CINEMETA = (process.env.CINEMETA_URL || 'https://v3-cinemeta.strem.io').replace(/\/$/, '');

const cache = new Cache();
const jobs = new Map(); // cacheKey -> job

function manifest(cfg) {
  const lang = cfg ? cfg.lang : 'tur';
  const label = (LANGUAGES[lang] && LANGUAGES[lang].label) || lang;
  return {
    id: 'community.gemini.subtitle.translator',
    version: pkg.version,
    name: cfg ? `Gemini Altyazı Çevirmeni (${label})` : 'Gemini Altyazı Çevirmeni',
    description: 'Mevcut altyazıları Google Gemini ile seçtiğin dile çevirir (varsayılan: Türkçe). Kendi Gemini API anahtarınla çalışır.',
    logo: 'https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a690345.svg',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: !cfg },
  };
}

function resolveApiKey(cfg) {
  if (cfg.key) return cfg.key;
  if (SERVER_KEY && (!ADDON_PASSWORD || cfg.pass === ADDON_PASSWORD)) return SERVER_KEY;
  return '';
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function isAllowedSubUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_SUB_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch (_) {
    return false;
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  });
  res.end(payload);
}

const SETUP_MESSAGE =
  'Eklenti ayarsız kurulmuş. Ayar sayfasında (/configure) Gemini anahtarınla link oluştur ve eklentiyi o linkle yeniden ekle.';

const STALE_MESSAGE =
  'Bu eski, önbellekte kalmış bir altyazı. Eklenti artık hazır: bölümü kapatıp yeniden aç ve listeden diğer Türkçe (Gemini) altyazıyı seç.';

function errorSrt(message) {
  return serializeSrt([
    { start: '00:00:01,000', end: '09:59:59,000', text: `Gemini Altyazı Çevirmeni: ${message}` },
  ]);
}

async function fetchText(url, timeoutMs = 20000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': `gemini-subtitle-translator/${pkg.version}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ---- translation jobs -------------------------------------------------------

function cacheKey(srcUrl, cfg, style) {
  const styleKey = style === 'kr' ? `kr-${cfg.hon}` : 'std';
  return crypto.createHash('sha1').update(`${srcUrl}|${cfg.lang}|${cfg.model}|${styleKey}|v3`).digest('hex');
}

// Is this title South Korean? Uses Cinemeta (the metadata addon Stremio/Nuvio use). Cached per title.
const originCache = new Map();
async function isKoreanTitle(type, id) {
  const imdb = id.split(':')[0];
  const key = `${type}/${imdb}`;
  if (originCache.has(key)) return originCache.get(key);
  let korean = false;
  try {
    const meta = JSON.parse(await fetchText(`${CINEMETA}/meta/${type}/${imdb}.json`, 6000)).meta || {};
    const country = Array.isArray(meta.country) ? meta.country.join(',') : String(meta.country || '');
    korean = /south korea|republic of korea|(^|,)\s*korea\s*(,|$)/i.test(country);
  } catch (err) {
    console.warn('cinemeta lookup failed:', err.message);
    return false; // don't cache failures
  }
  originCache.set(key, korean);
  if (originCache.size > 2000) originCache.delete(originCache.keys().next().value);
  return korean;
}

function startJob(srcUrl, cfg, apiKey, style = 'std') {
  const key = cacheKey(srcUrl, cfg, style);
  if (jobs.has(key)) return jobs.get(key);
  const job = { key, cues: null, translated: null, done: false, error: null };
  job.promise = (async () => {
    const cached = await cache.get(key);
    if (cached) return cached;
    const t0 = Date.now();
    const original = await fetchText(srcUrl);
    const cues = parseSrt(original);
    if (!cues.length) throw new Error('Kaynak altyazı boş ya da okunamadı');
    job.cues = cues;
    job.translated = cues.map(() => null);
    const texts = cues.map((c) => c.text);
    const targetName = languageName(cfg.lang);
    const extra = styleInstructions(style, { honorifics: cfg.hon });
    // Episode notes (characters, sen/siz, terms) keep the parallel batches consistent. A fast model
    // reads the whole episode first; if it is slow or fails, we translate without notes.
    let notes = null;
    if (NOTES_MODEL) {
      const tn = Date.now();
      notes = await Promise.race([
        buildNotes(texts, { apiKey, model: NOTES_MODEL, targetName, extra }),
        new Promise((r) => setTimeout(() => r(null), NOTES_WAIT_MS).unref()),
      ]);
      console.log(`episode notes: ${notes ? `${notes.characters.length} characters, ${notes.terms.length} terms` : 'none'}, ${Math.round((Date.now() - tn) / 1000)}s`);
    }
    const out = await translateTexts(
      texts,
      {
        notes,
        apiKey,
        model: cfg.model,
        targetName,
        concurrency: CONCURRENCY,
        batchSize: parseInt(process.env.GEMINI_BATCH_SIZE, 10) || 250,
        batchChars: 16000,
        extra,
        onProgress: (i, t) => {
          job.translated[i] = t;
        },
      },
    );
    const srt = serializeSrt(cues.map((c, i) => ({ ...c, text: out[i] })));
    await cache.set(key, srt);
    console.log(`translation done: ${cues.length} lines, model=${cfg.model}, ${Math.round((Date.now() - t0) / 1000)}s`);
    return srt;
  })()
    .then((srt) => {
      job.done = true;
      return srt;
    })
    .catch((err) => {
      job.error = err;
      throw err;
    })
    .finally(() => {
      // keep the job briefly so a player retry can reuse the result, then drop it
      setTimeout(() => jobs.delete(key), 60000).unref();
    });
  job.promise.catch(() => {}); // avoid unhandled rejection for prewarm jobs
  jobs.set(key, job);
  return job;
}

function partialSrt(job) {
  if (!job.cues) return null;
  return serializeSrt(job.cues.map((c, i) => ({ ...c, text: job.translated[i] || c.text })));
}

// ---- handlers -----------------------------------------------------------------

async function handleSubtitles(req, res, cfgStr, cfg, type, id, extra) {
  const apiKey = resolveApiKey(cfg);
  let list;
  try {
    const extraPart = extra ? `/${extra}` : '';
    const raw = await fetchText(`${SUBTITLE_SOURCE}/subtitles/${type}/${id}${extraPart}.json`);
    list = JSON.parse(raw).subtitles || [];
  } catch (err) {
    console.warn('subtitle source error:', err.message);
    return send(res, 200, { subtitles: [] });
  }

  const korean = cfg.kr === 'on' || (cfg.kr === 'auto' && (await isKoreanTitle(type, id)));
  const style = korean ? 'kr' : 'std';
  // For Korean titles, translate from the Korean subtitle when there is one: English subs usually lose the honorifics.
  const srcOrder = korean && cfg.lang !== 'kor' ? ['kor', ...cfg.src.filter((l) => l !== 'kor')] : cfg.src;

  // Prefer the subtitle made for this exact file (hash match) or the same release (filename), so it stays in sync.
  const picked = rankForSync(list, srcOrder, parseExtra(extra), isAllowedSubUrl).slice(0, cfg.max);

  const base = baseUrl(req);
  const subtitles = picked.map((s, n) => ({
    id: `gemini-${cfg.lang}-${s.id || n}`,
    url: `${base}/${cfgStr}/translate/${style}/${Buffer.from(s.url).toString('base64url')}.srt`,
    lang: cfg.lang,
  }));

  if (PREWARM && apiKey && picked[0]) startJob(picked[0].url, cfg, apiKey, style);
  console.log(`subtitles ${type}/${id}: ${list.length} source, ${subtitles.length} offered, style=${style}, from=${picked.map((p) => `${p.lang}:${p._sync}`).join(',')}`);
  return send(res, 200, { subtitles, cacheMaxAge: 3600 });
}

async function handleTranslate(req, res, cfg, encodedUrl, style = 'std') {
  const srt = (body, extra = {}) => send(res, 200, body, 'application/x-subrip; charset=utf-8', extra);
  let srcUrl;
  try {
    srcUrl = Buffer.from(encodedUrl, 'base64url').toString('utf8');
  } catch (_) {
    srcUrl = '';
  }
  if (!isAllowedSubUrl(srcUrl)) return send(res, 400, 'Bad subtitle URL', 'text/plain');

  const apiKey = resolveApiKey(cfg);
  if (!apiKey) return srt(errorSrt('Gemini API anahtarı yok. Eklentiyi ayar sayfasından yeniden kur.'), { 'Cache-Control': 'no-store' });

  const job = startJob(srcUrl, cfg, apiKey, style === 'kr' ? 'kr' : 'std');
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), WAIT_MS);
  });
  try {
    const result = await Promise.race([job.promise, timeout]);
    clearTimeout(timer);
    if (result) return srt(result, { 'Cache-Control': 'public, max-age=86400' });
    // Took too long: give the player what we have (rest stays in the original language).
    const partial = partialSrt(job);
    console.warn('translation timeout, sending partial result');
    return srt(partial || errorSrt('Çeviri hâlâ sürüyor, birazdan altyazıyı yeniden seç.'), { 'Cache-Control': 'no-store' });
  } catch (err) {
    clearTimeout(timer);
    console.warn('translation failed:', err.message);
    const partial = partialSrt(job);
    if (partial && (!err.fatal || err.status === 429)) return srt(partial, { 'Cache-Control': 'no-store' });
    return srt(errorSrt(`Çeviri başarısız (${err.message})`), { 'Cache-Control': 'no-store' });
  }
}

async function handleTestKey(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10000) return send(res, 413, { ok: false });
  }
  let input;
  try {
    input = JSON.parse(body || '{}');
  } catch (_) {
    return send(res, 400, { ok: false, error: 'Geçersiz istek' });
  }
  const cfg = decodeConfig(encodeConfig(input)) || {};
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) return send(res, 200, { ok: false, error: 'API anahtarı girilmedi (ya da sunucu şifresi yanlış).' });
  try {
    const [out] = await translateTexts(["Hey, where have you been? We've been waiting for hours!"], {
      apiKey,
      model: cfg.model,
      targetName: languageName(cfg.lang),
      retries: 1,
    });
    return send(res, 200, { ok: true, sample: out });
  } catch (err) {
    return send(res, 200, { ok: false, error: err.message });
  }
}

async function router(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const url = new URL(req.url, 'http://x');
  const rawParts = url.pathname.split('/').filter(Boolean);
  let parts;
  try {
    parts = rawParts.map((p) => decodeURIComponent(p));
  } catch (_) {
    return send(res, 400, { error: 'bad url' });
  }

  if (req.method === 'POST' && url.pathname === '/api/test') return handleTestKey(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  if (SERVER_KEY && !ADDON_PASSWORD && (parts[0] === 'manifest.json' || parts[0] === 'subtitles')) {
    rawParts.unshift(SHORT_LINK_CFG);
    parts.unshift(SHORT_LINK_CFG);
  }
  // /tr/manifest.json: same as the short link, under a fresh URL (helps when a proxy like AIOStreams cached old answers).
  if (SERVER_KEY && !ADDON_PASSWORD && parts[0] === 'tr' && parts.length > 1) {
    rawParts[0] = SHORT_LINK_CFG;
    parts[0] = SHORT_LINK_CFG;
  }

  if (parts.length === 0) return send(res, 302, '', 'text/plain', { Location: '/configure' });
  if (parts[0] === 'health') return send(res, 200, { ok: true, version: pkg.version });
  if (parts[0] === 'configure' || parts[1] === 'configure') {
    const cfg = parts[1] === 'configure' ? decodeConfig(parts[0]) : null;
    return send(res, 200, configurePage({ cfg, serverKey: Boolean(SERVER_KEY), needsPassword: Boolean(SERVER_KEY && ADDON_PASSWORD), defaultModel: DEFAULT_MODEL }), 'text/html; charset=utf-8');
  }
  if (parts[0] === 'manifest.json') return send(res, 200, manifest(null));
  // Installed from the bare /manifest.json (no settings in the link): explain the fix in the player instead of a 404.
  if (parts[0] === 'subtitles') {
    return send(res, 200, {
      subtitles: [{ id: 'gemini-setup-needed', url: `${baseUrl(req)}/setup-needed.srt`, lang: 'tur' }],
      cacheMaxAge: 0,
    });
  }
  if (parts[0] === 'setup-needed.srt') {
    // With a server key this link is only reached from an old answer a proxy (e.g. AIOStreams) still holds in its cache.
    const msg = SERVER_KEY && !ADDON_PASSWORD ? STALE_MESSAGE : SETUP_MESSAGE;
    return send(res, 200, errorSrt(msg), 'application/x-subrip; charset=utf-8', { 'Cache-Control': 'no-store' });
  }

  const cfgStr = parts[0];
  const cfg = decodeConfig(cfgStr);
  if (!cfg) return send(res, 404, { error: 'not found' });
  const rest = parts.slice(1);

  if (rest[0] === 'manifest.json') return send(res, 200, manifest(cfg));

  if (rest[0] === 'subtitles' && rest.length >= 3) {
    // /subtitles/:type/:id.json   or   /subtitles/:type/:id/:extra.json
    const type = rest[1];
    let id;
    let extra = '';
    if (rest.length === 3) id = rest[2].replace(/\.json$/, '');
    else {
      id = rest[2];
      extra = rawParts.slice(4).join('%2F').replace(/\.json$/, ''); // keep it URL-encoded as received
    }
    if (!['movie', 'series'].includes(type) || !/^tt\d+(:\d+:\d+)?$/.test(id)) return send(res, 200, { subtitles: [] });
    return handleSubtitles(req, res, cfgStr, cfg, type, id, extra);
  }

  if (rest[0] === 'translate' && rest.length === 3) return handleTranslate(req, res, cfg, rest[2].replace(/\.srt$/, ''), rest[1]);
  if (rest[0] === 'translate' && rest[1]) return handleTranslate(req, res, cfg, rest[1].replace(/\.srt$/, ''));

  return send(res, 404, { error: 'not found' });
}

// Access log without secrets: the settings segment (which holds the Gemini key) is replaced by <cfg>.
function redactPath(rawUrl) {
  const pathname = String(rawUrl || '').split('?')[0];
  const parts = pathname.split('/');
  return parts
    .map((p, i) => {
      if (i === 1 && p && decodeConfig(safeDecode(p))) return '<cfg>';
      if (i === 1 && p.length > 40) return '<bad-cfg>';
      if (p.length > 40) return p.slice(0, 16) + '…';
      return p;
    })
    .join('/');
}
function safeDecode(p) {
  try {
    return decodeURIComponent(p);
  } catch (_) {
    return p;
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const t0 = Date.now();
    res.on('finish', () => {
      if (req.url === '/health') return;
      const ua = String(req.headers['user-agent'] || '-').slice(0, 60);
      console.log(`req ${req.method} ${redactPath(req.url)} -> ${res.statusCode} ${Date.now() - t0}ms ua="${ua}"`);
    });
    router(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`Gemini subtitle translator listening on http://localhost:${PORT}`);
    console.log(`Configure page: http://localhost:${PORT}/configure`);
  });
}

module.exports = { createServer, manifest, startJob, jobs, cache };
