'use strict';
// Pick the source subtitle most likely to be in sync with the video being played.
// A subtitles addon never sees the stream itself, only what the player sends along:
// videoHash/videoSize (OpenSubtitles hash of the exact file) and filename. We use those.

function parseExtra(extra) {
  if (!extra) return {};
  let s = extra;
  try {
    s = decodeURIComponent(extra);
  } catch {
    /* keep as is */
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(s)) out[k] = v;
  return out;
}

const SOURCES = [
  ['bluray', /\b(blu-?ray|bdrip|brrip|bd)\b/],
  ['webdl', /\bweb-?dl\b/],
  ['webrip', /\bweb-?rip\b/],
  ['web', /\bweb\b/],
  ['hdtv', /\bhdtv\b/],
  ['dvd', /\bdvd(rip)?\b/],
];
const RES = /\b(2160|1080|720|576|540|480|450)p\b/;
const NOISE = new Set(['srt', 'mkv', 'mp4', 'avi', 'h264', 'h265', 'x264', 'x265', 'hevc', 'aac', 'ac3', 'ddp', 'dd', 'the', 'a', 'of', 'and']);

function norm(s) {
  return String(s || '').toLowerCase().replace(/\.(mkv|mp4|avi|srt)$/, '');
}
function tokens(s) {
  return new Set(norm(s).split(/[^a-z0-9]+/).filter((t) => t && !NOISE.has(t)));
}
function sourceOf(s) {
  for (const [name, re] of SOURCES) if (re.test(s)) return name;
  return '';
}
function groupOf(s) {
  const m = norm(s).match(/-([a-z0-9]+)(?:\[[^\]]*\])?$/);
  return m ? m[1] : '';
}

// Higher is better. 1000+ means OpenSubtitles matched the exact file by hash.
function syncScore(sub, filename) {
  let score = 0;
  if (sub.m === 'h') score += 1000;
  if (!filename) return score;
  const f = norm(filename);
  const names = String(sub.movieReleaseName || '').split(/\r?\n/).concat(sub.subtitleFileName || '').map(norm).filter(Boolean);
  if (!names.length) return score;
  const fGroup = groupOf(f);
  const fSrc = sourceOf(f);
  const fRes = (f.match(RES) || [])[1];
  const fTok = tokens(f);
  let best = 0;
  for (const n of names) {
    let s = 0;
    if (n === f) s += 300;
    const g = String(sub.releaseGroup || '').toLowerCase() || groupOf(n);
    if (fGroup && (g === fGroup || groupOf(n) === fGroup)) s += 120;
    const nSrc = sourceOf(n);
    if (fSrc && nSrc) s += fSrc === nSrc || (fSrc.startsWith('web') && nSrc.startsWith('web')) ? 60 : -40;
    const nRes = (n.match(RES) || [])[1];
    if (fRes && nRes) s += fRes === nRes ? 25 : -10;
    const nTok = tokens(n);
    let common = 0;
    for (const t of fTok) if (nTok.has(t)) common++;
    s += Math.round((40 * common) / Math.max(1, Math.max(fTok.size, nTok.size)));
    best = Math.max(best, s);
  }
  return score + best;
}

// Keeps only allowed languages, then orders by how well each one fits the file, then by language preference.
function rankForSync(list, langOrder, extraParams, isAllowed) {
  const filename = extraParams.filename || '';
  const rows = [];
  const seen = new Set();
  list.forEach((s, i) => {
    const li = langOrder.indexOf(s.lang);
    if (li < 0 || !s.url || seen.has(s.url) || (isAllowed && !isAllowed(s.url))) return;
    seen.add(s.url);
    rows.push({ s, li, i, score: syncScore(s, filename) });
  });
  const hasSignal = rows.some((r) => r.score > 0);
  rows.sort((a, b) => (hasSignal ? b.score - a.score : 0) || a.li - b.li || a.i - b.i);
  return rows.map((r) => ({ ...r.s, _sync: r.score }));
}

module.exports = { parseExtra, syncScore, rankForSync };
