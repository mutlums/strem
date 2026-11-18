'use strict';

// Translates subtitle text with the Gemini API (REST, no SDK needed).
// Cues are sent in numbered batches as JSON and come back as JSON, so timing
// and numbering never pass through the model: only the text does.

const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

class FatalTranslationError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.fatal = true;
  }
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { id: { type: 'INTEGER' }, text: { type: 'STRING' } },
        required: ['id', 'text'],
      },
    },
  },
  required: ['lines'],
};

function systemPrompt(targetName, extra = '') {
  const base = [
    `You are a professional subtitle translator. Translate every subtitle line into ${targetName}.`,
    'Rules:',
    '- Return exactly one item per input line, with the same id. Never merge, split, skip or reorder lines.',
    '- Write natural, concise, spoken-style subtitles a native speaker would use. Keep the tone (formal/informal, slang, swearing).',
    '- Keep line breaks (\\n) inside a line where they make sense for reading.',
    '- Keep formatting tags exactly as they are, e.g. <i>, </i>, <b>, <font ...>, {\\an8}.',
    '- Keep names of people and places. Translate sound descriptions like [door slams] or (laughs).',
    '- Lines that only contain music symbols or are already in the target language stay unchanged.',
    '- The "context" lines are earlier dialogue for reference only. Do not translate or return them.',
  ].join('\n');
  return extra ? `${base}\n\n${extra}` : base;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pace requests per API key and model: Gemini's free tier allows only a few requests per minute
// (Flash-Lite more than Flash), and several translations (both list options, a prewarm,
// other users of the same key) can run at once. GEMINI_RPM overrides it (0 = no pacing).
const ENV_RPM = process.env.GEMINI_RPM !== undefined ? parseInt(process.env.GEMINI_RPM, 10) || 0 : undefined;
function defaultRpm(model) {
  if (ENV_RPM !== undefined) return ENV_RPM;
  return /lite/i.test(model || '') ? 12 : 8;
}
const recentCalls = new Map(); // api key + model -> timestamps of recent requests

async function waitForSlot(apiKey, rpm) {
  if (!rpm) return;
  for (;;) {
    const now = Date.now();
    const list = (recentCalls.get(apiKey) || []).filter((t) => now - t < 60000);
    if (list.length < rpm) {
      list.push(now);
      recentCalls.set(apiKey, list);
      return;
    }
    await sleep(60000 - (now - list[0]) + 50);
  }
}

// "Please retry in 21.1s" / RetryInfo.retryDelay "21s" -> milliseconds
function retryDelayMs(errBody, detail) {
  const details = (errBody && errBody.error && errBody.error.details) || [];
  for (const d of details) {
    if (d && typeof d.retryDelay === 'string') {
      const n = parseFloat(d.retryDelay);
      if (n > 0) return Math.ceil(n * 1000);
    }
  }
  const m = /retry in ([\d.]+)\s*s/i.exec(detail || '');
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
}

async function callGemini({ apiKey, model, targetName, items, context, extra = '', fetchImpl = fetch, baseUrl = GEMINI_BASE_URL, retries = 4, rpm = defaultRpm(model) }) {
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(targetName, extra) }] },
    contents: [
      {
        role: 'user',
        parts: [{ text: JSON.stringify({ target_language: targetName, context, lines: items }) }],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  let lastErr;
  let rateWaits = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    await waitForSlot(`${apiKey}|${model}`, rpm);
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err; // network error: retry
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const cand = data.candidates && data.candidates[0];
      const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map((p) => p.text || '').join('') : '';
      if (!text) return new Map(); // blocked/empty: caller falls back
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        return new Map();
      }
      const out = new Map();
      for (const l of (parsed && parsed.lines) || []) {
        if (l && Number.isInteger(l.id) && typeof l.text === 'string') out.set(l.id, l.text);
      }
      return out;
    }

    let detail = '';
    let errBody = null;
    try {
      errBody = await res.json();
      detail = (errBody.error && errBody.error.message) || '';
    } catch (_) {
      /* ignore */
    }

    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      // Bad key, wrong model name, API not enabled... retrying won't help.
      throw new FatalTranslationError(detail || `Gemini HTTP ${res.status}`, res.status);
    }
    lastErr = new Error(detail || `Gemini HTTP ${res.status}`);
    lastErr.status = res.status;
    if (res.status === 429) {
      if (/per ?day|PerDay/i.test(detail)) {
        throw new FatalTranslationError('Gemini günlük ücretsiz kotası doldu, yarın tekrar dene ya da başka bir anahtar kullan.', 429);
      }
      // Per-minute limit: wait as long as Gemini asks, without using up the normal retries.
      const wait = retryDelayMs(errBody, detail);
      if (wait > 0 && rateWaits < 6) {
        rateWaits++;
        attempt--;
        await sleep(Math.min(wait, 65000) + 500);
        continue;
      }
    }
    // 5xx (or 429 without a retry hint): back off and retry.
    const retryAfter = parseInt(res.headers.get && res.headers.get('retry-after'), 10);
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt);
  }
  if (lastErr && lastErr.status === 429) {
    throw new FatalTranslationError('Gemini dakikalık limiti aşıldı, birazdan altyazıyı yeniden seç.', 429);
  }
  throw lastErr || new Error('Gemini request failed');
}

function makeBatches(texts, { batchSize, batchChars }) {
  const batches = [];
  let cur = [];
  let chars = 0;
  texts.forEach((t, i) => {
    if (cur.length && (cur.length >= batchSize || chars + t.length > batchChars)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += t.length;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Translate an array of strings. Returns an array of the same length.
 * Lines the model fails to return keep their original text.
 * onProgress(index, translatedText) is called as lines finish.
 */
async function translateTexts(texts, opts) {
  const {
    apiKey,
    model,
    targetName,
    batchSize = 80,
    batchChars = 6000,
    concurrency = 3,
    contextLines = 3,
    onProgress = () => {},
    fetchImpl,
    baseUrl,
    retries,
    rpm,
    extra = '',
  } = opts;

  const result = texts.slice();
  const batches = makeBatches(texts, { batchSize, batchChars });

  async function runBatch(indices) {
    const items = indices.map((i) => ({ id: i, text: texts[i] }));
    const first = indices[0];
    const context = texts.slice(Math.max(0, first - contextLines), first);
    const got = await callGemini({ apiKey, model, targetName, items, context, extra, fetchImpl, baseUrl, retries, rpm });
    const missing = indices.filter((i) => !got.has(i) || !got.get(i).trim());
    for (const i of indices) {
      if (got.has(i) && got.get(i).trim()) {
        result[i] = got.get(i);
        onProgress(i, result[i]);
      }
    }
    if (missing.length && missing.length < indices.length) {
      // Model dropped some lines: retry just those (smaller batches are more reliable).
      if (missing.length > 1) {
        const mid = Math.ceil(missing.length / 2);
        await runBatch(missing.slice(0, mid));
        await runBatch(missing.slice(mid));
      } else {
        await runSingle(missing[0]);
      }
    } else if (missing.length === indices.length && indices.length > 1) {
      // Whole batch failed (e.g. safety block on one line): split it.
      const mid = Math.ceil(indices.length / 2);
      await runBatch(indices.slice(0, mid));
      await runBatch(indices.slice(mid));
    }
  }

  async function runSingle(i) {
    const got = await callGemini({ apiKey, model, targetName, items: [{ id: i, text: texts[i] }], context: [], extra, fetchImpl, baseUrl, retries, rpm });
    if (got.has(i) && got.get(i).trim()) {
      result[i] = got.get(i);
      onProgress(i, result[i]);
    }
    // otherwise the original line stays
  }

  let next = 0;
  let fatal = null;
  async function worker() {
    while (next < batches.length && !fatal) {
      const b = batches[next++];
      try {
        await runBatch(b);
      } catch (err) {
        if (err.fatal) fatal = err;
        // non-fatal errors: leave this batch untranslated, keep going
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (fatal) throw fatal;
  return result;
}

module.exports = { translateTexts, callGemini, makeBatches, FatalTranslationError, systemPrompt };
