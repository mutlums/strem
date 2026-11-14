'use strict';

// Minimal, forgiving SRT (and simple WebVTT) parser/serializer.

const TIME_RE = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})(.*)$/;

function normalizeTime(t) {
  const [hms, msRaw = '0'] = t.replace('.', ',').split(',');
  const parts = hms.split(':').map((p) => p.trim());
  while (parts.length < 3) parts.unshift('0');
  const [h, m, s] = parts;
  const ms = msRaw.padEnd(3, '0').slice(0, 3);
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')},${ms}`;
}

function finalize(cue) {
  const lines = cue.lines;
  const dropTrailingEmpty = () => {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  };
  dropTrailingEmpty();
  // A lone number right after a blank line is the index of the next cue.
  if (lines.length >= 2 && /^\s*\d+\s*$/.test(lines[lines.length - 1]) && lines[lines.length - 2].trim() === '') {
    lines.pop();
    dropTrailingEmpty();
  }
  while (lines.length && lines[0].trim() === '') lines.shift();
  return {
    start: normalizeTime(cue.start),
    end: normalizeTime(cue.end),
    text: lines.map((l) => l.replace(/\s+$/, '')).join('\n'),
  };
}

function parseSrt(input) {
  const text = String(input || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = TIME_RE.exec(line);
    if (m) {
      if (cur) cues.push(finalize(cur));
      cur = { start: m[1], end: m[2], lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) cues.push(finalize(cur));
  return cues.filter((c) => c.text.trim() !== '');
}

function serializeSrt(cues) {
  return cues
    .filter((c) => c.text && c.text.trim() !== '')
    .map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${c.text.trim()}\n`)
    .join('\n');
}

module.exports = { parseSrt, serializeSrt, normalizeTime };
