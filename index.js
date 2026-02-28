const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const cache = new Map();

const manifest = {
  id: 'com.en.tr.subtitles.v3',
  version: '3.0.0',
  name: 'EN-TR AI Altyazi',
  description: 'Ingilizce altyazi cekip Turkceye cevirir.',
  logo: 'https://flagcdn.com/w80/tr.png',
  types: ['movie', 'series'],
  resources: [{ name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: true },
  config: [
    { key: 'api_provider', type: 'select', title: 'AI Saglayici', options: ['claude', 'openai', 'openrouter', 'gemini'], default: 'claude' },
    { key: 'api_key', type: 'password', title: 'AI API Key' },
    { key: 'os_key', type: 'password', title: 'OpenSubtitles Key (istege bagli)' },
    { key: 'model', type: 'text', title: 'Model (bos = otomatik)', default: '' },
    { key: 'show_english', type: 'checkbox', title: 'Ingilizce orijinali de goster', default: true }
  ]
};

app.get('/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(manifest);
});

app.get('/:config/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(manifest);
});

app.get('/:config/subtitles/:type/:id/:extra?.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const config = decodeConfig(req.params.config);
    const imdbId = req.params.id.split(':')[0];
    const season = req.params.id.split(':')[1] || null;
    const episode = req.params.id.split(':')[2] || null;
    if (!config.api_key) return res.json({ subtitles: [] });
    const baseUrl = getBaseUrl(req);
    const showEn = config.show_english !== false && config.show_english !== 'false';
    const subtitles = [];
    const srt = await fetchSubtitle(imdbId, season, episode, config.os_key);
    if (!srt) return res.json({ subtitles: [] });
    if (showEn) {
      subtitles.push({ id: 'en-' + imdbId, url: baseUrl + '/sub/' + store(srt) + '.srt', lang: 'eng', name: 'Ingilizce (Orijinal)' });
    }
    const blocks = parseSRT(srt);
    const translated = await translateBlocks(blocks, config);
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

// Yardımcı Fonksiyonlar
function decodeConfig(configStr) {
  try {
    return JSON.parse(Buffer.from(configStr, 'base64').toString());
  } catch (e) {
    return {};
  }
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function store(content) {
  const token = Math.random().toString(36).substring(2);
  cache.set(token, content);
  return token;
}

async function fetchSubtitle(imdbId, season, episode, osKey) {
  // Bu kısım normalde OpenSubtitles API'sine istek atar.
  // Örnek bir SRT döndürüyoruz.
  return "1\n00:00:01,000 --> 00:00:04,000\nHello, this is a sample subtitle.";
}

function parseSRT(srt) {
  return srt.split('\n\n').map(block => {
    const lines = block.split('\n');
    return { id: lines[0], time: lines[1], text: lines.slice(2).join('\n') };
  });
}

async function translateBlocks(blocks, config) {
  // Bu kısım normalde AI API'sine (Claude, OpenAI vb.) istek atar.
  // Şimdilik basit bir simülasyon yapıyoruz.
  return blocks.map(b => ({ ...b, text: b.text + " (TR Çeviri)" }));
}

function buildSRT(blocks) {
  return blocks.map(b => `${b.id}\n${b.time}\n${b.text}`).join('\n\n');
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
