const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const cache = new Map();

const API_PROVIDER = process.env.API_PROVIDER || 'openrouter';
const API_KEY = process.env.API_KEY || '';
const MODEL = process.env.MODEL || 'anthropic/claude-sonnet-4-5';

const manifest = {
  id: 'com.en.tr.subtitles.v4',
  version: '4.0.0',
  name: 'EN-TR AI Altyazi',
  description: 'Ingilizce altyazi cekip Turkceye cevirir.',
  logo: 'https://flagcdn.com/w80/tr.png',
  types: ['movie', 'series'],
  resources: [{ name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false }
};

app.get('/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(manifest);
});

app.get('/:config/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(manifest);
});

app.get('/subtitles/:type/:id/:extra?.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const imdbId = req.params.id.split(':')[0];
    const season = req.params.id.split(':')[1] || null;
    const episode = req.params.id.split(':')[2] || null;
    const baseUrl = getBaseUrl(req);
    const subtitles = [];
    const srt = await fetchSubtitle(imdbId, season, episode);
    if (!srt) return res.json({ subtitles: [] });
    subtitles.push({ id: 'en-' + imdbId, url: baseUrl + '/sub/' + store(srt) + '.srt', lang: 'eng', name: 'Ingilizce (Orijinal)' });
    const blocks = parseSRT(srt);
    const translated = await translateBlocks(blocks);
    const trSrt = buildSRT(translated);
    subtitles.push({ id: 'tr-' + imdbId, url: baseUrl + '/sub/' + store(trSrt) + '.srt', lang: 'tur', name: 'Turkce (AI)' });
    res.json({ subtitles });
  } catch (e) {
    console.error(e.message);
    res.json({ subtitles: [] });
  }
});

app.get('/:config/subtitles/:type/:id/:extra?.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const imdbId = req.params.id.split(':')[0];
    const season = req.params.id.split(':')[1] || null;
    const episode = req.params.id.split(':')[2] || null;
    const baseUrl = getBaseUrl(req);
    const subtitles = [];
    const srt = await fetchSubtitle(imdbId, season, episode);
    if (!srt) return res.json({ subtitles: [] });
    subtitles.push({ id: 'en-' + imdbId, url: baseUrl + '/sub/' + store(srt) + '.srt', lang: 'eng', name: 'Ingilizce (Orijinal)' });
    const blocks = parseSRT(srt);
    const translated = await translateBlocks(blocks);
    const trSrt = buildSRT(translated);
    subtitles.push({ id: 'tr-' + imdbId, url: baseUrl + '/sub/' + store(trSrt) + '.srt', lang: 'tur', name: 'Turkce (AI)' });
    res.json({ subtitles });
  } catch (e) {
    console.error(e.message);
    res.json({ subtitles: [] });
  }
});

app.get('/sub/:token.srt', (req, res) => {
  const srt = cache.get(req.params.token);
  if (!srt) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(srt);
});

app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('<html><body style="background:#111;color:#fff;font-family:sans-serif;padding:30px;text-align:center"><h2>✅ Addon Aktif</h2></body></html>');
});

async function fetchSubtitle(imdbId, season, episode) {
  try {
    let url = 'https://api.wyzie.ru/search?imdb_id=' + imdbId + '&language=en';
    if (season) url += '&season=' + season;
    if (episode) url += '&episode=' + episode;
    const results = await fetch(url).then(r => r.json());
    if (!results || !results.length) return null;
    const srtUrl = results[0].url;
    if (!srtUrl) return null;
    return await fetch(srtUrl).then(r => r.text());
  } catch (e) {
    console.error('[Wyzie Error]', e.message);
    return null;
  }
}

function parseSRT(text) {
  return text.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\n+/).reduce((acc, part) => {
    const lines = part.trim().split('\n');
    if (lines.length < 3) return acc;
    const content = lines.slice(2).join('\n').replace(/<[^>]+>/g, '').trim();
    if (content) acc.push({ num: lines[0].trim(), time: lines[1].trim(), original: content, translated: '' });
    return acc;
  }, []);
}

function buildSRT(blocks) {
  return blocks.map(b => b.num + '\n' + b.time + '\n' + (b.translated || b.original)).join('\n\n') + '\n';
}

function store(srt) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  cache.set(token, srt);
  setTimeout(() => cache.delete(token), 7200000);
  return token;
}

const PROMPT = 'Sen uzman bir Ingilizce-Turkce cevirmenisin. SRT altyazi bloklarini Turkceye cevir. KURAL: Sadece cevrilmis metni dondur. Bloklari ||| ile ayir. Baska hicbir sey ekleme. Dogal ve akici Turkce kullan.';

async function translateBlocks(blocks) {
  const BATCH = 20;
  for (let i = 0; i < blocks.length; i += BATCH) {
    const batch = blocks.slice(i, i + BATCH);
    try {
      const result = await callAI(batch.map(b => b.original).join('\n|||\n'));
      const parts = result.split('|||');
      batch.forEach((b, idx) => { b.translated = (parts[idx] || b.original).trim(); });
    } catch (e) {
      console.error('[AI Error]', e.message);
      batch.forEach(b => { b.translated = b.original; });
    }
    if (i + BATCH < blocks.length) await sleep(200);
  }
  return blocks;
}

async function callAI(msg) {
  if (API_PROVIDER === 'openrouter') {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: msg }] })
    });
    const d = await r.json();
    if (d.error) throw new Error(JSON.stringify(d.error));
    return d.choices[0].message.content;
  } else if (API_PROVIDER === 'claude') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: PROMPT, messages: [{ role: 'user', content: msg }] })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.content[0].text;
  } else if (API_PROVIDER === 'gemini') {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent?key=' + API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: PROMPT }] }, contents: [{ parts: [{ text: msg }] }], generationConfig: { maxOutputTokens: 4096 } })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.candidates[0].content.parts[0].text;
  }
  throw new Error('Unknown provider');
}

function getBaseUrl(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + (req.headers['x-forwarded-host'] || req.get('host'));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => { console.log('Addon running on port ' + PORT); });
