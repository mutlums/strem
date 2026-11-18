'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseExtra, rankForSync } = require('../src/match');

const LIST = [
  { id: 'a', url: 'u/a', lang: 'eng', m: 'i', movieReleaseName: 'My.Beautiful.Bride.E02.150621.HDTV.H264.720p-WITH', releaseGroup: 'WITH' },
  { id: 'b', url: 'u/b', lang: 'eng', m: 'i', movieReleaseName: 'My.Beautiful.Bride.2015.E02.1080p.WEB-DL.AAC-NTb', releaseGroup: 'NTb' },
  { id: 'c', url: 'u/c', lang: 'kor', m: 'i', movieReleaseName: 'My.Beautiful.Bride.E02.HDTV.450p-CHAOS' },
  { id: 'd', url: 'u/d', lang: 'spa', m: 'h', movieReleaseName: 'whatever' },
];

test('parseExtra reads Stremio extra segments, encoded or not', () => {
  assert.deepStrictEqual(parseExtra('videoHash=abc&videoSize=12&filename=My.Show.S01E02.mkv'), {
    videoHash: 'abc', videoSize: '12', filename: 'My.Show.S01E02.mkv',
  });
  assert.strictEqual(parseExtra('filename%3DMy%20Show%20E02.mkv').filename, 'My Show E02.mkv');
  assert.deepStrictEqual(parseExtra(''), {});
});

test('without file info the language order is kept', () => {
  const r = rankForSync(LIST, ['kor', 'eng'], {});
  assert.deepStrictEqual(r.map((s) => s.id), ['c', 'a', 'b']);
});

test('same release group and source wins over language order', () => {
  const r = rankForSync(LIST, ['kor', 'eng'], { filename: 'My.Beautiful.Bride.S01E02.1080p.WEB-DL.AAC-NTb.mkv' });
  assert.strictEqual(r[0].id, 'b');
  const r2 = rankForSync(LIST, ['eng'], { filename: 'My Beautiful Bride E02 150621 HDTV H264 720p-WITH.mp4' });
  assert.strictEqual(r2[0].id, 'a');
});

test('a hash match on an allowed language beats everything', () => {
  const list = LIST.map((s) => (s.id === 'a' ? { ...s, m: 'h' } : s));
  const r = rankForSync(list, ['kor', 'eng'], { filename: 'My.Beautiful.Bride.S01E02.1080p.WEB-DL.AAC-NTb.mkv' });
  assert.strictEqual(r[0].id, 'a');
  // a hash-matched subtitle in a language the user did not allow is still left out
  assert.ok(!r.some((s) => s.id === 'd'));
});

test('urls the addon may not fetch are dropped', () => {
  const r = rankForSync(LIST, ['eng'], {}, (u) => u !== 'u/a');
  assert.deepStrictEqual(r.map((s) => s.id), ['b']);
});
