'use strict';
// Pure, dependency-free hashrate math shared by the pool stats writers
// (portal_bridge.js — the immediate fix — and ingest_client.js — the strategic home).
//
// A worker's live hashrate is a TIME-WINDOWED, count-based figure:
//
//     H/s = ( SUM of accepted shareDiff over the last WINDOW seconds ) * SCRYPT_MULT / WINDOW
//
// This decays on its own as old shares age out of the window and drops to 0 once a worker
// stops submitting shares. It replaces the old per-share EWMA in recordShare, which:
//   - blended a stale historical rate (never decayed when a worker stopped), and
//   - inflated ~4x under test because a small time-since-last-share (dt) — made smaller
//     when several machines shared one worker_key — divided into the per-share estimate.
//
// SCRYPT_MULT = 2^16 matches the engine's algoProperties.js scrypt `multiplier`.

const SCRYPT_MULT = Math.pow(2, 16); // scrypt share-diff -> H/s scaling (engine algoProperties multiplier)
const WINDOW_SEC  = 300;             // rolling window used for the live-rate average
const IDLE_SEC    = 90;              // no share for this long => worker offline + hashrate 0

// Drop events older than (now - windowSec*1000). Mutates and returns the same array,
// which is assumed to be in ascending-ts order (shares are appended as they arrive).
function pruneEvents(events, now, windowSec) {
  if (!events || !events.length) return events || [];
  windowSec = windowSec || WINDOW_SEC;
  const cutoff = now - windowSec * 1000;
  let i = 0;
  while (i < events.length && events[i].ts < cutoff) i++;
  if (i > 0) events.splice(0, i);
  return events;
}

// H/s = sum(diff) * mult / windowSec. `events` should already be pruned to the window
// (this sums every event it is given).
function computeHashrate(events, windowSec, mult) {
  windowSec = windowSec || WINDOW_SEC;
  mult = (mult == null) ? SCRYPT_MULT : mult;
  let sum = 0;
  if (events) for (let i = 0; i < events.length; i++) sum += (events[i].diff || 0);
  return (sum * mult) / windowSec;
}

// Full per-worker evaluation used by the sweeper / flusher. Prunes `events` in place,
// then applies idle zeroing. Returns { hashrate, online } where online is 0/1.
//   events      : ascending-ts array of { ts:<ms>, diff:<number> }
//   lastShareMs : epoch ms of the worker's most recent accepted share (0/null if never)
//   now         : epoch ms "now" (injectable for deterministic tests)
function evaluateWorker(events, lastShareMs, now, opts) {
  opts = opts || {};
  const windowSec = opts.windowSec || WINDOW_SEC;
  const idleSec   = opts.idleSec   || IDLE_SEC;
  const mult      = (opts.mult == null) ? SCRYPT_MULT : opts.mult;
  pruneEvents(events, now, windowSec);
  const idle = !lastShareMs || (now - lastShareMs) > idleSec * 1000;
  if (idle) return { hashrate: 0, online: 0 };
  return { hashrate: computeHashrate(events, windowSec, mult), online: 1 };
}

module.exports = { SCRYPT_MULT, WINDOW_SEC, IDLE_SEC, pruneEvents, computeHashrate, evaluateWorker };
