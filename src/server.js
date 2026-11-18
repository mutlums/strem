'use strict';

const http = require('http');
const crypto = require('crypto');
const { parseSrt, serializeSrt } = require('./srt');
const { translateTexts } = require('./translator');
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
const CONCURRENCY = parseInt(process.env.GEMINI_CONCURRENCY, 10) || 2;
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

function errorSrt(message) {
  return serializeSrt([
    { start: '00:00:01,000', end: '00:00:15,000', text: `Gemini Altyazı Çevirmeni: ${message}` },
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
  return crypto.createHash('sha1').update(`${srcUrl}|${cfg.lang}|${cfg.model}|${styleKey}|v2`).digest('hex');
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
    const original = await fetchText(srcUrl);
    const cues = parseSrt(original);
    if (!cues.length) throw new Error('Kaynak altyazı boş ya da okunamadı');
    job.cues = cues;
    job.translated = cues.map(() => null);
    const out = await translateTexts(
      cues.map((c) => c.text),
      {
        apiKey,
        model: cfg.model,
        targetName: languageName(cfg.lang),
        concurrency: CONCURRENCY,
        batchSize: parseInt(process.env.GEMINI_BATCH_SIZE, 10) || 100,
        batchChars: 7000,
        extra: styleInstructions(style, { honorifics: cfg.hon }),
        onProgress: (i, t) => {
          job.translated[i] = t;
        },
      },
    );
    const srt = serializeSrt(cues.map((c, i) => ({ ...c, text: out[i] })));
    await cache.set(key, srt);
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

  const picked = [];
  const seen = new Set();
  for (const lang of srcOrder) {
    for (const s of list) {
      if (picked.length >= cfg.max) break;
      if (s.lang !== lang || !s.url || seen.has(s.url) || !isAllowedSubUrl(s.url)) continue;
      seen.add(s.url);
      picked.push(s);
    }
  }

  const base = baseUrl(req);
  const subtitles = picked.map((s, n) => ({
    id: `gemini-${cfg.lang}-${s.id || n}`,
    url: `${base}/${cfgStr}/translate/${style}/${Buffer.from(s.url).toString('base64url')}.srt`,
    lang: cfg.lang,
  }));

  if (PREWARM && apiKey && picked[0]) startJob(picked[0].url, cfg, apiKey, style);
  console.log(`subtitles ${type}/${id}: ${list.length} source, ${subtitles.length} offered, style=${style}, from=${picked.map((p) => p.lang).join(',')}`);
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
    return send(res, 200, errorSrt(SETUP_MESSAGE), 'application/x-subrip; charset=utf-8', { 'Cache-Control': 'no-store' });
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

function createServer() {
  return http.createServer((req, res) => {
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
