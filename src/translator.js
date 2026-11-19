'use strict';

// Translates subtitle text with the Gemini API (REST, no SDK needed).
// Cues are sent in numbered batches as JSON and come back as JSON, so timing
// and numbering never pass through the model: only the text does.

const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

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

// Extra rules that make Turkish subtitles read like they were written in Turkish, not translated.
const TURKISH_RULES = [
  'Turkish style (most important: it must read as if a Turkish subtitler wrote it, never like a word-for-word translation):',
  '- Translate the meaning and intent of each line, not its words. Rebuild the sentence in natural Turkish word order (verb usually last).',
  '- Turkish drops subject pronouns: write "Geliyorum", not "Ben geliyorum", unless the pronoun is stressed. Avoid "o/onlar/bu" where the verb ending is enough.',
  '- Use everyday spoken Turkish for dialogue: "Ne yapıyorsun?", "Nereye gidiyorsun?", "Boş ver.", "Olur mu öyle şey?", "Dalga mı geçiyorsun?".',
  '  Avoid stiff written or translated phrasing: say "Buna gerek var mı?", not "Bunu yapmaya ihtiyacın var mı?".',
  '- Replace idioms and fixed phrases with real Turkish equivalents, not literal ones: "Come on" -> "Hadi ama", "No way" -> "Olamaz" / "Hayatta olmaz",',
  '  "Never mind" -> "Boş ver", "Take care" -> "Kendine iyi bak", "I\'m sorry" -> "Özür dilerim" / "Kusura bakma" (apology) or "Başın sağ olsun" (loss),',
  '  "Oh my God" -> "Aman Allahım" / "Hay Allah" (vary it), "Excuse me" -> "Pardon" / "Bakar mısınız?". Vary repeated fillers ("Tamam", "Vay canına", "Lütfen") the way people really talk.',
  '- Match each speaker\'s voice: a child, a grandmother, a gangster and a CEO must not sound alike. Keep jokes, sarcasm and insults working in Turkish.',
  '- Keep the "sen"/"siz" choice consistent for the same two people, and keep the verb endings matching it.',
  '- Correct Turkish spelling and punctuation: ç ğ ı İ ö ş ü, "de/da" and "ki" written separately when they are conjunctions, a question particle "mı/mi/mu/mü" written separately.',
  '- Reading speed: keep subtitles short and easy to read, at most about 42 characters per line and 2 lines. Shorten wordy lines without losing meaning.',
  '- When one sentence runs over several lines, each line must still read naturally on its own and the lines together must form one correct Turkish sentence.',
  '  You may move words between those lines so the Turkish order works, but keep each line close to what is said at that moment.',
].join('\n');

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
    '- "context_before" and "context_after" are the surrounding dialogue, for reference only (who is talking, what a line refers to). Do not translate or return them.',
    '- "notes", when given, describe the characters, how they address each other and fixed terms for the whole episode. Follow them so every part of the episode is consistent.',
  ].join('\n');
  const parts = [base];
  if (/^turkish$/i.test(targetName)) parts.push(TURKISH_RULES);
  if (extra) parts.push(extra);
  return parts.join('\n\n');
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

async function callGemini({ apiKey, model, targetName, items, context = [], contextAfter = [], notes = null, extra = '', fetchImpl = fetch, baseUrl = GEMINI_BASE_URL, retries = 4, rpm = defaultRpm(model) }) {
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(targetName, extra) }] },
    contents: [
      {
        role: 'user',
        parts: [{ text: JSON.stringify({ target_language: targetName, ...(notes ? { notes } : {}), context_before: context, context_after: contextAfter, lines: items }) }],
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
        const e = new FatalTranslationError('Gemini günlük ücretsiz kotası doldu, yarın tekrar dene ya da başka bir anahtar kullan.', 429);
        e.daily = true;
        throw e;
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

// The same request through OpenRouter (OpenAI-style chat API), used as the last fallback when Gemini's
// free quotas are used up. `model` may list several models separated by commas: OpenRouter then tries
// them in order when one is busy or down. Only ":free" models are used by default, so nothing is billed.
function parseLinesJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch (_) {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch (_) {
        /* fall through */
      }
    }
  }
  return null;
}

const JSON_SHAPE = 'Answer with JSON only, no other text, exactly in this shape: {"lines":[{"id":<the same id>,"text":"<the translated line>"}]}';

async function callOpenRouter({ apiKey, model, targetName, items, context = [], contextAfter = [], notes = null, extra = '', fetchImpl = fetch, baseUrl = OPENROUTER_BASE_URL, retries = 3, rpm = 15 }) {
  const models = String(model || '').split(',').map((m) => m.trim()).filter(Boolean);
  const body = {
    ...(models.length > 1 ? { models } : { model: models[0] }),
    messages: [
      { role: 'system', content: `${systemPrompt(targetName, extra)}\n\n${JSON_SHAPE}` },
      { role: 'user', content: JSON.stringify({ target_language: targetName, ...(notes ? { notes } : {}), context_before: context, context_after: contextAfter, lines: items }) },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    await waitForSlot(`openrouter|${apiKey}`, rpm);
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Title': 'Subtitle translator' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* ignore */
    }
    // OpenRouter can also put an error inside a 200 response.
    const errObj = data && data.error;
    const status = res.ok && !errObj ? 200 : (errObj && Number(errObj.code)) || res.status || 500;
    if (status === 200) {
      const choice = data && data.choices && data.choices[0];
      const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
      const parsed = parseLinesJson(text);
      const out = new Map();
      const list = Array.isArray(parsed) ? parsed : (parsed && parsed.lines) || [];
      for (const l of list) {
        const id = l && (Number.isInteger(l.id) ? l.id : parseInt(l.id, 10));
        if (Number.isInteger(id) && typeof l.text === 'string') out.set(id, l.text);
      }
      return out;
    }
    const detail = (errObj && errObj.message) || `OpenRouter HTTP ${status}`;
    if (status === 401 || status === 403) throw new FatalTranslationError('OpenRouter anahtarı geçersiz.', status);
    if (status === 402) throw Object.assign(new FatalTranslationError('OpenRouter bakiyesi yetersiz.', 402), { daily: true });
    if (status === 404 && /data policy|privacy/i.test(detail)) {
      throw new FatalTranslationError('OpenRouter gizlilik ayarı ücretsiz modelleri engelliyor (Settings > Privacy).', 404);
    }
    if (status === 400 || status === 404) throw new FatalTranslationError(`OpenRouter: ${detail}`, status);
    lastErr = new Error(detail);
    lastErr.status = status;
    if (status === 429 && /per[- ]?day|daily|free-models-per-day/i.test(detail)) {
      throw Object.assign(new FatalTranslationError('OpenRouter günlük ücretsiz kotası da doldu, yarın tekrar dene.', 429), { daily: true });
    }
    const retryAfter = parseInt(res.headers && res.headers.get && res.headers.get('retry-after'), 10);
    await sleep(retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 2000 * 2 ** attempt);
  }
  if (lastErr && lastErr.status === 429) throw new FatalTranslationError('OpenRouter şu an yoğun, birazdan altyazıyı yeniden seç.', 429);
  throw lastErr || new Error('OpenRouter request failed');
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
    targetName,
    batchSize = 80,
    batchChars = 6000,
    concurrency = 3,
    contextLines = 8,
    contextAfterLines = 4,
    notes = null,
    fallbackModel = '',
    fallbacks: fallbackList,
    primary = null,
    onFallback = () => {},
    onProgress = () => {},
    fetchImpl,
    baseUrl,
    retries,
    rpm,
    extra = '',
  } = opts;

  const result = texts.slice();
  const batches = makeBatches(texts, { batchSize, batchChars });
  // When the chosen model's daily free quota runs out, carry on with the next step of the chain
  // (Gemini Flash-Lite, then OpenRouter's free models) instead of leaving the episode untranslated.
  // A "primary" step (e.g. a paid OpenRouter model) runs before the chosen Gemini model. Any error
  // there, like an empty balance, moves on to Gemini instead of failing the episode.
  const steps = [];
  if (primary && primary.model) {
    steps.push({ provider: primary.provider || 'openrouter', model: primary.model, apiKey: primary.apiKey || apiKey, rpm: primary.rpm, soft: true });
  }
  steps.push({ provider: 'gemini', model: opts.model, apiKey });
  for (const f of fallbackList || (fallbackModel ? [{ model: fallbackModel }] : [])) {
    if (f && f.model) steps.push({ provider: f.provider || 'gemini', model: f.model, apiKey: f.apiKey || apiKey, rpm: f.rpm });
  }
  let step = 0;
  const call = (args) => {
    const s = steps[step];
    const fn = s.provider === 'openrouter' ? callOpenRouter : callGemini;
    return fn({ ...args, apiKey: s.apiKey, model: s.model, targetName, notes, extra, fetchImpl, retries, ...(s.provider === 'openrouter' ? (s.rpm ? { rpm: s.rpm } : {}) : { baseUrl, rpm }) });
  };

  async function runBatch(indices) {
    const items = indices.map((i) => ({ id: i, text: texts[i] }));
    const first = indices[0];
    const last = indices[indices.length - 1];
    const context = texts.slice(Math.max(0, first - contextLines), first);
    const contextAfter = texts.slice(last + 1, last + 1 + contextAfterLines);
    const got = await call({ items, context, contextAfter });
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
    const got = await call({ items: [{ id: i, text: texts[i] }], context: texts.slice(Math.max(0, i - 3), i), contextAfter: texts.slice(i + 1, i + 3) });
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
      for (;;) {
        const usedStep = step;
        const todo = usedStep === 0 && step === 0 ? b : b.filter((i) => result[i] === texts[i]);
        if (!todo.length) break;
        try {
          await runBatch(todo);
          break;
        } catch (err) {
          if ((err.daily || steps[usedStep].soft) && usedStep + 1 < steps.length) {
            // Out of daily quota (or the primary step failed): move to the next step (once, even with
            // parallel workers) and redo the rest of this batch.
            if (step === usedStep) {
              step = usedStep + 1;
              onFallback(steps[step].model, steps[step].provider, err);
            }
            continue;
          }
          if (err.fatal) fatal = err;
          break; // non-fatal errors: leave this batch untranslated, keep going
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (fatal) throw fatal;
  Object.defineProperty(result, 'usedModel', { value: steps[step].model, enumerable: false });
  return result;
}

// One quick look at the whole episode before translating it, so every batch (they run in parallel)
// uses the same name spellings, the same sen/siz between the same people and the same terms.
const NOTES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    characters: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, who: { type: 'STRING' } },
        required: ['name', 'who'],
      },
    },
    address: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { between: { type: 'STRING' }, form: { type: 'STRING' } },
        required: ['between', 'form'],
      },
    },
    terms: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { source: { type: 'STRING' }, target: { type: 'STRING' } },
        required: ['source', 'target'],
      },
    },
  },
  required: ['summary', 'characters', 'address', 'terms'],
};

function notesPrompt(targetName, extra = '') {
  const base = [
    `You prepare a subtitle translation into ${targetName}. Read the whole episode's subtitles and write short notes for the translators.`,
    'Do not translate the lines. Return JSON with:',
    '- summary: two or three sentences on what happens and the tone (comedy, thriller, romance...).',
    '- characters: the main people (at most 15), with the name spelled as it must appear in the translation, and "who": gender, rough age and role,',
    '  e.g. "woman, 30s, the bride" (gender matters: the source language may hide it).',
    `- address: for the main pairs who talk to each other, how they address each other in ${targetName}, e.g. between "Ji-woo -> her mother-in-law", form "siz, Eomeoni".`,
    `- terms: recurring names of places, companies, titles or invented words, with the one ${targetName} form to use everywhere (at most 20).`,
    'Keep every field short. Use only what the subtitles show; leave a list empty when unsure.',
  ].join('\n');
  return extra ? `${base}\n\nThe translation follows these style rules, so the notes should too:\n${extra}` : base;
}

/**
 * Builds episode notes (characters, sen/siz, terms) from the whole subtitle. Returns null on any failure:
 * the translation then simply runs without notes.
 */
async function buildNotes(texts, { apiKey, model, targetName, extra = '', maxChars = 60000, fetchImpl = fetch, baseUrl = GEMINI_BASE_URL, rpm }) {
  let script = '';
  for (const t of texts) {
    const line = t.replace(/<[^>]+>|\{\\[^}]*\}/g, '').replace(/\s*\n\s*/g, ' ').trim();
    if (!line) continue;
    if (script.length + line.length + 1 > maxChars) break;
    script += `${line}\n`;
  }
  if (!script) return null;
  const body = {
    systemInstruction: { parts: [{ text: notesPrompt(targetName, extra) }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify({ task: 'notes', target_language: targetName, subtitles: script }) }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: NOTES_SCHEMA },
  };
  try {
    await waitForSlot(`${apiKey}|${model}`, rpm === undefined ? defaultRpm(model) : rpm);
    const res = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map((p) => p.text || '').join('') : '';
    const n = JSON.parse(text || 'null');
    if (!n || typeof n !== 'object') return null;
    const list = (a, max) => (Array.isArray(a) ? a.filter((x) => x && typeof x === 'object').slice(0, max) : []);
    const notes = {
      summary: typeof n.summary === 'string' ? n.summary.slice(0, 600) : '',
      characters: list(n.characters, 15),
      address: list(n.address, 20),
      terms: list(n.terms, 20),
    };
    if (!notes.summary && !notes.characters.length && !notes.address.length && !notes.terms.length) return null;
    return notes;
  } catch (_) {
    return null;
  }
}

module.exports = { translateTexts, callGemini, callOpenRouter, parseLinesJson, makeBatches, buildNotes, FatalTranslationError, systemPrompt };
