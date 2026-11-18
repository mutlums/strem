'use strict';
// Short link (no settings in the URL) with GEMINI_API_KEY on the server: works with default settings.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

test('short link uses the server key and default settings', async (t) => {
  const source = http.createServer((req, res) => {
    if (req.url.startsWith('/meta/')) return res.end(JSON.stringify({ meta: { country: 'United States' } }));
    if (req.url.startsWith('/subtitles/movie/tt0111161')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ subtitles: [{ id: '2', url: `http://127.0.0.1:${source.address().port}/file/en.srt`, lang: 'eng' }] }));
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => source.listen(0, '127.0.0.1', r));
  t.after(() => source.close());
  process.env.GEMINI_API_KEY = 'SERVER-KEY';
  delete process.env.ADDON_PASSWORD;
  process.env.SUBTITLE_SOURCE = `http://127.0.0.1:${source.address().port}`;
  process.env.CINEMETA_URL = process.env.SUBTITLE_SOURCE;
  process.env.ALLOWED_SUB_HOSTS = '127.0.0.1';
  process.env.PREWARM = 'false';
  process.env.GEMINI_RPM = '0';
  const { createServer } = require('../src/server.js');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const man = await (await fetch(`${base}/manifest.json`)).json();
  assert.strictEqual(man.behaviorHints.configurationRequired, false);

  const subs = await (await fetch(`${base}/subtitles/movie/tt0111161.json`)).json();
  assert.ok(subs.subtitles.length >= 1, 'offers a translated subtitle');
  assert.ok(subs.subtitles.every((s) => !s.url.includes('setup-needed')), 'no setup hint');
  assert.ok(subs.subtitles[0].url.includes('/translate/'), 'points at the translate route');
});
