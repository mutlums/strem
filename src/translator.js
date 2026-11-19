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
  // When the chosen model's daily free quota runs out, carry on with the fallback model
  // (Flash-Lite has a much larger free quota) instead of leaving the episode untranslated.
  let model = opts.model;

  async function runBatch(indices) {
    const items = indices.map((i) => ({ id: i, text: texts[i] }));
    const first = indices[0];
    const last = indices[indices.length - 1];
    const context = texts.slice(Math.max(0, first - contextLines), first);
    const contextAfter = texts.slice(last + 1, last + 1 + contextAfterLines);
    const got = await callGemini({ apiKey, model, targetName, items, context, contextAfter, notes, extra, fetchImpl, baseUrl, retries, rpm });
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
    const got = await callGemini({ apiKey, model, targetName, items: [{ id: i, text: texts[i] }], context: texts.slice(Math.max(0, i - 3), i), contextAfter: texts.slice(i + 1, i + 3), notes, extra, fetchImpl, baseUrl, retries, rpm });
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
        if (err.daily && fallbackModel) {
          if (model !== fallbackModel) {
            model = fallbackModel;
            onFallback(fallbackModel);
          }
          try {
            await runBatch(b.filter((i) => result[i] === texts[i]));
          } catch (err2) {
            if (err2.fatal) fatal = err2; // the fallback is out of quota too
          }
        } else if (err.fatal) fatal = err;
        // non-fatal errors: leave this batch untranslated, keep going
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (fatal) throw fatal;
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

module.exports = { translateTexts, callGemini, makeBatches, buildNotes, FatalTranslationError, systemPrompt };
