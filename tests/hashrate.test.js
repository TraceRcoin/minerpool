'use strict';
// Pure unit tests for the windowed hashrate core (hashrate.js) — no native deps, run with
//   node --test
// These lock in the fix for the ~4x inflation / no-decay bug described in
// trustworthy-pool-dashboard.md scope A.

const test = require('node:test');
const assert = require('node:assert');
const hr = require('../hashrate.js');

const MULT = hr.SCRYPT_MULT; // 65536
const WINDOW = 300;
const IDLE = 90;

// Build a steady stream of `shares` accepted shares of difficulty `diff`, evenly spaced,
// ending at `endTs`, spanning `spanSec` seconds.
function steadyStream(endTs, spanSec, shares, diff) {
  const ev = [];
  const step = (spanSec * 1000) / shares;
  for (let i = 0; i < shares; i++) {
    ev.push({ ts: endTs - (spanSec * 1000) + Math.round(i * step), diff: diff });
  }
  return ev;
}

test('computeHashrate matches sum*mult/window exactly', () => {
  const ev = [{ ts: 0, diff: 8 }, { ts: 1, diff: 8 }, { ts: 2, diff: 8 }]; // sum 24
  const h = hr.computeHashrate(ev, WINDOW, MULT);
  assert.strictEqual(h, (24 * MULT) / WINDOW);
});

test('a real ~144 kH/s single-machine stream reads ~144 kH/s, NOT ~594 kH/s', () => {
  const now = 1_000_000_000_000;
  // 144 kH/s with diff-8 shares => shares/sec = 144000 / (8*65536) = 0.27466/s
  // over 300 s => ~82 shares, total shareDiff ~= 659.
  const sharesPerSec = 144000 / (8 * MULT);
  const shares = Math.round(sharesPerSec * WINDOW);      // ~82
  const ev = steadyStream(now, WINDOW, shares, 8);
  const r = hr.evaluateWorker(ev, now, now, { windowSec: WINDOW, idleSec: IDLE, mult: MULT });
  assert.strictEqual(r.online, 1);
  // within 2% of the true 144000, and nowhere near the buggy 594000
  assert.ok(Math.abs(r.hashrate - 144000) / 144000 < 0.02, 'got ' + r.hashrate);
  assert.ok(r.hashrate < 200000, 'must not inflate: ' + r.hashrate);
});

test('idle zeroing: worker with recent events but last share > 90s ago reads 0 / offline', () => {
  const now = 2_000_000_000_000;
  const ev = steadyStream(now - 120000, 60, 20, 8); // last share 120s ago (> IDLE)
  const lastShareMs = now - 120000;
  const r = hr.evaluateWorker(ev, lastShareMs, now, { windowSec: WINDOW, idleSec: IDLE, mult: MULT });
  assert.strictEqual(r.online, 0);
  assert.strictEqual(r.hashrate, 0);
});

test('decay: once all shares age out of the window, hashrate falls to 0', () => {
  const now = 3_000_000_000_000;
  // shares that ended just over WINDOW ago, and lastShare also old -> idle & pruned
  const ev = steadyStream(now - (WINDOW + 60) * 1000, 60, 20, 8);
  const lastShareMs = now - (WINDOW + 60) * 1000;
  const r = hr.evaluateWorker(ev, lastShareMs, now, { windowSec: WINDOW, idleSec: IDLE, mult: MULT });
  assert.strictEqual(r.hashrate, 0);
  assert.strictEqual(r.online, 0);
  assert.strictEqual(ev.length, 0, 'stale events should be pruned');
});

test('active worker just inside idle window stays online with a decayed (lower) rate', () => {
  const now = 4_000_000_000_000;
  // last share 80s ago (< 90 idle) but only a few recent shares -> lower live rate
  const ev = steadyStream(now - 80000, 80, 5, 8); // 5 shares over the last 80s
  const lastShareMs = now - 80000;
  const r = hr.evaluateWorker(ev, lastShareMs, now, { windowSec: WINDOW, idleSec: IDLE, mult: MULT });
  assert.strictEqual(r.online, 1);
  assert.strictEqual(r.hashrate, (5 * 8 * MULT) / WINDOW);
});

test('pruneEvents drops only events older than the window and keeps ascending order', () => {
  const now = 5_000_000_000_000;
  const ev = [
    { ts: now - (WINDOW + 10) * 1000, diff: 8 }, // old -> pruned
    { ts: now - (WINDOW - 10) * 1000, diff: 8 }, // in window
    { ts: now - 1000, diff: 8 }                  // in window
  ];
  hr.pruneEvents(ev, now, WINDOW);
  assert.strictEqual(ev.length, 2);
  assert.ok(ev[0].ts < ev[1].ts);
});

test('never-submitted worker (no lastShare) is offline with 0 hashrate', () => {
  const now = 6_000_000_000_000;
  const r = hr.evaluateWorker([], 0, now, { windowSec: WINDOW, idleSec: IDLE, mult: MULT });
  assert.strictEqual(r.online, 0);
  assert.strictEqual(r.hashrate, 0);
});
