'use strict';
// End-to-end: a fake OpenSubtitles addon + a fake Gemini API on localhost,
// then the real addon server in between, called the way Nuvio/Stremio would.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'sample.en.srt'), 'utf8');

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
}
const portOf = (s) => s.address().port;
const get = async (url) => {
  const r = await fetch(url);
  return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
};

test('full flow: manifest -> subtitles list -> translated .srt', async (t) => {
  let geminiCalls = 0;
  const systemPrompts = [];
  const notesCalls = [];
  const notesSeen = [];
  const source = await listen((req, res) => {
    // fake Cinemeta
    if (req.url === '/meta/movie/tt6751668.json') return res.end(JSON.stringify({ meta: { name: 'Parasite', country: 'South Korea' } }));
    if (req.url.startsWith('/meta/')) return res.end(JSON.stringify({ meta: { country: 'United States' } }));
    if (req.url.startsWith('/subtitles/movie/tt6751668')) {
      const base = `http://127.0.0.1:${portOf(source)}`;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ subtitles: [
        { id: 'e1', url: `${base}/file/en.srt`, lang: 'eng' },
        { id: 'k1', url: `${base}/file/ko.srt`, lang: 'kor' },
      ] }));
    }
    if (req.url.startsWith('/subtitles/movie/tt0111161')) {
      const base = `http://127.0.0.1:${portOf(source)}`;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ subtitles: [
        { id: '1', url: `${base}/file/tr.srt`, lang: 'tur' },
        { id: '2', url: `${base}/file/en1.srt`, lang: 'eng' },
        { id: '3', url: `${base}/file/en2.srt`, lang: 'eng' },
        { id: '4', url: `${base}/file/en3.srt`, lang: 'eng' },
        { id: '5', url: 'https://evil.example.com/x.srt', lang: 'eng' },
      ] }));
    }
    if (req.url.startsWith('/file/')) return res.end(SAMPLE);
    res.statusCode = 404; res.end();
  });
  const gemini = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      geminiCalls++;
      assert.strictEqual(req.headers['x-goog-api-key'], 'TEST-KEY');
      assert.match(req.url, /\/models\/gemini-3\.(5-flash-lite|6-flash):generateContent$/);
      const parsed = JSON.parse(body);
      const input = JSON.parse(parsed.contents[0].parts[0].text);
      assert.strictEqual(input.target_language, 'Turkish');
      res.setHeader('Content-Type', 'application/json');
      if (input.task === 'notes') {
        // the quick read of the whole episode before translating
        notesCalls.push(input.subtitles);
        const notes = { summary: 'A test film.', characters: [{ name: 'Andy', who: 'man, 40s' }], address: [], terms: [] };
        return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(notes) }] } }] }));
      }
      systemPrompts.push(parsed.systemInstruction.parts[0].text);
      notesSeen.push(input.notes);
      assert.ok(Array.isArray(input.context_before) && Array.isArray(input.context_after));
      const lines = input.lines.map((l) => ({ id: l.id, text: `[TR] ${l.text}` }));
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ lines }) }] } }] }));
    });
  });

  process.env.SUBTITLE_SOURCE = `http://127.0.0.1:${portOf(source)}`;
  process.env.ALLOWED_SUB_HOSTS = '127.0.0.1';
  process.env.GEMINI_RPM = '0';
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${portOf(gemini)}`;
  process.env.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subcache-'));
  process.env.PREWARM = 'false';
  process.env.CINEMETA_URL = `http://127.0.0.1:${portOf(source)}`;
  const { createServer } = require('../src/server');
  const { encodeConfig } = require('../src/config');
  const addon = await listen(createServer().listeners('request')[0]);
  const A = `http://127.0.0.1:${portOf(addon)}`;
  t.after(() => { source.close(); gemini.close(); addon.close(); });

  // unconfigured manifest asks for configuration
  const m0 = JSON.parse((await get(`${A}/manifest.json`)).text);
  assert.strictEqual(m0.behaviorHints.configurationRequired, true);
  assert.deepStrictEqual(m0.resources, ['subtitles']);

  const cfg = encodeConfig({ key: 'TEST-KEY', lang: 'tur', model: 'gemini-3.5-flash-lite', src: ['eng'], max: 2 });
  const m = JSON.parse((await get(`${A}/${cfg}/manifest.json`)).text);
  assert.strictEqual(m.behaviorHints.configurationRequired, false);
  assert.match(m.name, /Türkçe/);

  // subtitles list, with the "extra" segment Stremio clients send
  const r = await get(`${A}/${cfg}/subtitles/movie/tt0111161/videoHash=abc&filename=Some%20Movie.mkv.json`);
  const subs = JSON.parse(r.text).subtitles;
  assert.strictEqual(subs.length, 2, 'max=2, only eng sources, evil host filtered');
  assert.ok(subs.every((s) => s.lang === 'tur' && s.url.endsWith('.srt')));

  // the translated file
  const srt = await get(subs[0].url);
  assert.strictEqual(srt.status, 200);
  assert.match(srt.type, /subrip/);
  assert.match(srt.text, /^1\n00:00:01,000 --> 00:00:03,500\n\[TR\] Hey, where have you been\?/);
  assert.match(srt.text, /\[TR\] <i>We've been waiting<\/i>\nfor hours!/);
  assert.strictEqual((srt.text.match(/-->/g) || []).length, 5, 'all 5 cues kept with timing');
  const callsAfterFirst = geminiCalls;
  // the whole episode was read once first, and its notes went along with every batch
  assert.strictEqual(notesCalls.length, 1);
  assert.match(notesCalls[0], /Hey, where have you been\?/);
  assert.ok(notesSeen.length > 0 && notesSeen.every((n) => n && n.characters[0].name === 'Andy'));
  // natural-Turkish rules are in the prompt
  assert.ok(systemPrompts.every((p) => /Turkish style/.test(p)));

  // second request comes from cache, no new Gemini calls
  const again = await get(subs[0].url);
  assert.strictEqual(again.text, srt.text);
  assert.strictEqual(geminiCalls, callsAfterFirst);

  // a URL outside the allowed hosts is refused
  const bad = await get(`${A}/${cfg}/translate/${Buffer.from('https://evil.example.com/a.srt').toString('base64url')}.srt`);
  assert.strictEqual(bad.status, 400);

  // series ids work too (source returns nothing here -> empty list, no crash)
  const s = JSON.parse((await get(`${A}/${cfg}/subtitles/series/tt0903747:1:1.json`)).text);
  assert.deepStrictEqual(s.subtitles, []);

  // the non-Korean film used the standard prompt
  assert.ok(systemPrompts.length > 0 && systemPrompts.every((p) => !/South Korean/.test(p)));

  // Korean film: auto-detected, Korean subtitle offered first, Korean culture prompt used
  const kr = JSON.parse((await get(`${A}/${cfg}/subtitles/movie/tt6751668.json`)).text).subtitles;
  assert.strictEqual(kr.length, 2);
  assert.match(kr[0].url, /\/translate\/kr\//);
  const firstSrc = Buffer.from(kr[0].url.split('/translate/kr/')[1].replace(/\.srt$/, ''), 'base64url').toString();
  assert.match(firstSrc, /ko\.srt$/, 'Korean source preferred for Korean titles');
  const before = systemPrompts.length;
  const krSrt = await get(kr[0].url);
  assert.strictEqual(krSrt.status, 200);
  const krPrompts = systemPrompts.slice(before);
  assert.ok(krPrompts.length > 0 && krPrompts.every((p) => /South Korean/.test(p) && /Oppa, Hyung, Unnie/.test(p) && /"siz"/.test(p)));

  // hon=tr switches honorifics to Turkish equivalents; kr=off disables the mode
  const cfgTr = encodeConfig({ key: 'TEST-KEY', hon: 'tr' });
  const krTr = JSON.parse((await get(`${A}/${cfgTr}/subtitles/movie/tt6751668.json`)).text).subtitles;
  const b2 = systemPrompts.length;
  await get(krTr[0].url);
  assert.ok(systemPrompts.slice(b2).every((p) => /Oppa\/Hyung -> abi/.test(p)));
  const cfgOff = encodeConfig({ key: 'TEST-KEY', kr: 'off' });
  const off = JSON.parse((await get(`${A}/${cfgOff}/subtitles/movie/tt6751668.json`)).text).subtitles;
  assert.match(off[0].url, /\/translate\/std\//);

  // installed from the bare manifest (no settings): a setup hint instead of a 404
  const bare = await get(`${A}/subtitles/movie/tt0111161.json`);
  assert.strictEqual(bare.status, 200);
  const hint = JSON.parse(bare.text).subtitles;
  assert.strictEqual(hint.length, 1);
  const hintSrt = await get(hint[0].url);
  assert.strictEqual(hintSrt.status, 200);
  assert.match(hintSrt.text, /ayarsız kurulmuş/);

  // configure page renders, with the Korean options
  const page = await get(`${A}/configure`);
  assert.match(page.text, /Gemini Altyazı Çevirmeni/);
  assert.match(page.text, /Kore hitapları/);
});
