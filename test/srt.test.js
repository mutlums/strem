'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseSrt, serializeSrt } = require('../src/srt');

test('parses SRT with BOM, tags, multi-line and numeric text', () => {
  const cues = parseSrt(fs.readFileSync(path.join(__dirname, 'sample.en.srt'), 'utf8'));
  assert.strictEqual(cues.length, 5);
  assert.strictEqual(cues[0].start, '00:00:01,000');
  assert.strictEqual(cues[0].end, '00:00:03,500');
  assert.strictEqual(cues[1].text, "<i>We've been waiting</i>\nfor hours!");
  assert.strictEqual(cues[2].text, '1984');
  assert.strictEqual(cues[3].text, '{\\an8}[door slams]');
});

test('parses CRLF and normalizes dot/short times', () => {
  const cues = parseSrt(fs.readFileSync(path.join(__dirname, 'sample.crlf.srt'), 'utf8'));
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].text, 'CRLF line');
  assert.strictEqual(cues[1].start, '00:00:03,500');
  assert.strictEqual(cues[1].end, '00:00:04,250');
});

test('round-trips: serialize(parse(x)) parses to the same cues', () => {
  const cues = parseSrt(fs.readFileSync(path.join(__dirname, 'sample.en.srt'), 'utf8'));
  const again = parseSrt(serializeSrt(cues));
  assert.deepStrictEqual(again, cues);
  assert.match(serializeSrt(cues), /^1\n00:00:01,000 --> 00:00:03,500\nHey/);
});

test('parses WebVTT-style times without hours', () => {
  const cues = parseSrt('WEBVTT\n\n00:01.000 --> 00:02.500\nHello\n');
  assert.strictEqual(cues[0].start, '00:00:01,000');
  assert.strictEqual(cues[0].end, '00:00:02,500');
});
