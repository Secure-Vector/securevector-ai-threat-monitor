'use strict';
/* Statusline tool-call counts use the dashboard's definitions: tool calls =
 * audit rows in the 7-day window, allow = rows minus tool-policy blocks,
 * block = tool-policy blocks plus egress blocks. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SL = require(path.join(ROOT, 'src', 'securevector', 'plugins', 'claude-code', 'hooks', 'statusline.js'));

const NOW = new Date(2026, 10, 2, 12, 0, 0).getTime();
const day = (offset) => {
  const d = new Date(NOW - offset * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('egress blocks count as blocks and logged calls count as allowed', () => {
  const daily = { days: [
    { day: day(1), blocked: 0, allowed: 36, logged: 20 },
    { day: day(0), blocked: 0, allowed: 0, logged: 2 },
  ] };
  const egress = { destinations: [{ host: 'a.example', blocked: 1 }, { host: 'b.example', blocked: 0 }] };
  assert.deepEqual(SL.summarizeCounts(daily, egress, null, NOW), { total: 58, allowed: 58, blocked: 1, window: '7d' });
});

test('a tool-policy deny is a block and the rest are allowed', () => {
  const daily = { days: [{ day: day(0), blocked: 1, allowed: 0, logged: 9 }] };
  assert.deepEqual(SL.summarizeCounts(daily, { destinations: [] }, null, NOW), { total: 10, allowed: 9, blocked: 1, window: '7d' });
});

test('days before the 7-day window are left out, like the dashboard', () => {
  const daily = { days: [
    { day: day(7), blocked: 5, allowed: 5, logged: 5 },
    { day: day(6), blocked: 1, allowed: 2, logged: 0 },
  ] };
  assert.deepEqual(SL.summarizeCounts(daily, null, null, NOW), { total: 3, allowed: 2, blocked: 1, window: '7d' });
});

test('falls back to the all-time stats when the daily endpoint is missing', () => {
  const stats = { total: 10, allowed: 0, blocked: 0, log_only: 10 };
  assert.deepEqual(SL.summarizeCounts(null, null, stats, NOW), { total: 10, allowed: 10, blocked: 0, window: 'all' });
  assert.equal(SL.summarizeCounts(null, null, null, NOW), null);
});

const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, '');
const TOKENS = { daily: [{ day: '2026-11-01', input_tokens: 1_000_000, output_tokens: 400_000 }] };

test('the 7d label is printed once and covers counts and tokens', () => {
  const line = plain(SL.buildLine({ total: 10, allowed: 9, blocked: 1, window: '7d' }, TOKENS, null));
  assert.match(line, /7d 10 tool calls \(9 allow \/ 1 block\) · 1\.4M tok/);
  assert.equal((line.match(/7d/g) || []).length, 1);
});

test('all-time fallback counts are unlabelled; the tokens keep 7d', () => {
  const line = plain(SL.buildLine({ total: 10, allowed: 10, blocked: 0, window: 'all' }, TOKENS, null));
  assert.match(line, /· 10 tool calls \(10 allow \/ 0 block\) · 7d 1\.4M tok/);
  assert.equal((line.match(/7d/g) || []).length, 1);
});

test('fast fetches share one deadline', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'securevector', 'plugins', 'claude-code', 'hooks', 'statusline.js'), 'utf8');
  assert.equal(SL.FAST_TIMEOUT_MS, 1500);
  assert.match(src, /const deadline = Date\.now\(\) \+ FAST_TIMEOUT_MS;/);
  const main = src.slice(src.indexOf('async function statuslineMain'));
  assert.doesNotMatch(main.slice(0, main.indexOf('writeLiveCache(')), /getJson\([^)]*FAST_TIMEOUT_MS\)/);
});
