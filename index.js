const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const manifest = {
  id: 'com. dealt.stremio.en-tr-ai',
  version: '1.0.0',
  name: '🇬🇧→🇹🇷 AI Türkçe Altyazı',
  description: 'İngilizce altyazıları AI ile Türkçeye çevirir.',
  types: ['movie', 'series'],
  resources: [{ name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  behaviorHints: { configurable: false, configurationRequired: false }
};

app.get('/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(manifest);
});

app.get('/subtitles/:type/:id/:extra?.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Altyaz provide mantığı buraya gelecek
  res.json({ subtitles: [] });
});

app.listen(PORT, () => console.log('Sunucu hazir: ' + PORT));
