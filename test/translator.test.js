'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.GEMINI_RPM = '0'; // no pacing in tests
const { translateTexts, makeBatches } = require('../src/translator');

// Fake Gemini: echoes each line as "TR(<text>)".
function fakeFetch({ dropIdsOnce = [], failFirst = 0, status = 200, calls = [] } = {}) {
  const dropped = new Set();
  let failures = 0;
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (failures < failFirst) {
      failures++;
      return { ok: false, status: 429, headers: new Map([['retry-after', '0']]), json: async () => ({ error: { message: 'rate limited' } }) };
    }
    if (status !== 200) return { ok: false, status, headers: new Map(), json: async () => ({ error: { message: 'API key not valid' } }) };
    const body = JSON.parse(init.body);
    const req = JSON.parse(body.contents[0].parts[0].text);
    const lines = req.lines
      .filter((l) => {
        if (dropIdsOnce.includes(l.id) && !dropped.has(l.id)) { dropped.add(l.id); return false; }
        return true;
      })
      .map((l) => ({ id: l.id, text: `TR(${l.text})` }));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ lines }) }] } }] }) };
  };
}

const base = { apiKey: 'k', model: 'gemini-3.5-flash-lite', targetName: 'Turkish', baseUrl: 'http://fake' };

test('batches by count and size', () => {
  const b = makeBatches(['a'.repeat(10), 'b', 'c', 'd'.repeat(50), 'e'], { batchSize: 3, batchChars: 40 });
  assert.deepStrictEqual(b, [[0, 1, 2], [3], [4]]);
});

test('translates all lines, keeps order, sends key in header', async () => {
  const calls = [];
  const texts = Array.from({ length: 250 }, (_, i) => `line ${i}`);
  const out = await translateTexts(texts, { ...base, batchSize: 80, fetchImpl: fakeFetch({ calls }) });
  assert.strictEqual(out.length, 250);
  out.forEach((t, i) => assert.strictEqual(t, `TR(line ${i})`));
  assert.strictEqual(calls.length, 4);
  assert.strictEqual(calls[0].headers['x-goog-api-key'], 'k');
  assert.match(calls[0].url, /models\/gemini-3\.5-flash-lite:generateContent$/);
});

test('recovers lines the model dropped', async () => {
  const texts = ['a', 'b', 'c', 'd', 'e'];
  const out = await translateTexts(texts, { ...base, fetchImpl: fakeFetch({ dropIdsOnce: [1, 3] }) });
  assert.deepStrictEqual(out, ['TR(a)', 'TR(b)', 'TR(c)', 'TR(d)', 'TR(e)']);
});

test('retries on 429', async () => {
  const out = await translateTexts(['x'], { ...base, fetchImpl: fakeFetch({ failFirst: 2 }) });
  assert.deepStrictEqual(out, ['TR(x)']);
});

test('bad key is a fatal error', async () => {
  await assert.rejects(translateTexts(['x'], { ...base, fetchImpl: fakeFetch({ status: 400 }) }), (e) => e.fatal && /API key/.test(e.message));
});

test('per-minute 429 waits as long as Gemini asks, beyond the normal retries', async () => {
  let n = 0;
  const ok = fakeFetch();
  const fetchImpl = async (url, init) => {
    if (n++ < 3) {
      return { ok: false, status: 429, headers: new Map(), json: async () => ({ error: { message: 'Quota exceeded for metric: requests per minute. Please retry in 0.05s.', details: [{ retryDelay: '0.05s' }] } }) };
    }
    return ok(url, init);
  };
  const out = await translateTexts(['x'], { ...base, retries: 1, fetchImpl });
  assert.deepStrictEqual(out, ['TR(x)']);
});

test('daily quota is a clear fatal error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, headers: new Map(), json: async () => ({ error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests per day.' } }) });
  await assert.rejects(translateTexts(['x'], { ...base, fetchImpl }), (e) => e.fatal && /günlük/.test(e.message));
});

