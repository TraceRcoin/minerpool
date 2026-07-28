'use strict';
// Pool-side bridge: authorizes rigs against the miner portal's /api/portal/worker-auth
// and writes live pool_* stats/blocks/payouts into the (co-located) portal SQLite.
//
// STAGING build. To point at production, change PORTAL_HOST/PORTAL_PORT (or the base
// URL) and STAGING_DB to the production portal + its DB path, and supply the prod
// POOL_INTERNAL_TOKEN via the environment. Nothing else here is environment-specific.
//
// HASHRATE MODEL (feat/hashrate-window): recordShare no longer computes an instantaneous
// per-share rate or an EWMA. Each accepted share is appended to an in-memory rolling ring
// buffer keyed by worker_key; a periodic sweeper (setInterval) recomputes each worker's
// hashrate as a TIME-WINDOWED count-based average and zeroes it (and online) once a worker
// has been idle > IDLE_SEC. See hashrate.js for the shared math.

const http = require('http');
const Database = require('better-sqlite3');
const hr = require('./hashrate.js');

const DB_PATH      = process.env.STAGING_DB || '/var/lib/tfx-staging/portal.db';
const PORTAL_HOST  = process.env.PORTAL_HOST || '127.0.0.1';
const PORTAL_PORT  = parseInt(process.env.PORTAL_PORT || '8090', 10);
const AUTH_PATH    = '/api/portal/worker-auth';
const POOL_TOKEN   = process.env.POOL_INTERNAL_TOKEN || '';
const DEV_FEE      = 0.02;                 // 2% dev-fee skim (matches rewardRecipients)
const SCRYPT_MULT  = Math.pow(2, 16);      // rough H/s scaling from scrypt share diff (KEEP: matches engine algoProperties)

// Live-hashrate tuning (env-overridable). Defaults align with production-cutover.md §1.3.
const WINDOW_SEC    = parseInt(process.env.HASHRATE_WINDOW_SEC || String(hr.WINDOW_SEC), 10);   // rolling window
const IDLE_SEC      = parseInt(process.env.IDLE_TIMEOUT_SEC     || String(hr.IDLE_SEC), 10);    // idle => offline + 0
const SWEEP_INT_MS  = parseInt(process.env.SWEEP_INTERVAL_MS    || '15000', 10);                // sweeper cadence

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// login (lowercase 'account.worker') -> {account_id, payout_address, username, worker}
const authCache = {};
const lastShareTs = {};                    // worker_key -> epoch ms of most recent accepted share
const shareEvents = {};                    // worker_key -> ascending-ts array of { ts, diff }

function ensureRound() {
  const r = db.prepare('SELECT id FROM pool_round WHERE id=1').get();
  if (!r) {
    db.prepare('INSERT INTO pool_round (id, round_shares, network_target, started_at) VALUES (1,0,?,?)')
      .run(1000, new Date().toISOString());
  }
}
ensureRound();

// POST {login,password} with X-Pool-Token; cache the resolved account on success.
function workerAuth(login, password, cb) {
  const key = (login || '').toLowerCase();
  const payload = JSON.stringify({ login: key, password: password });
  const req = http.request({
    host: PORTAL_HOST, port: PORTAL_PORT, path: AUTH_PATH, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Pool-Token': POOL_TOKEN
    }
  }, function (res) {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', function () {
      if (res.statusCode === 200) {
        try {
          const j = JSON.parse(body);
          authCache[key] = {
            account_id: j.account_id,
            payout_address: j.payout_address,
            username: j.account,
            worker: j.worker
          };
          cb(null, authCache[key]);
        } catch (e) { cb(e); }
      } else {
        cb(new Error('worker-auth HTTP ' + res.statusCode));
      }
    });
  });
  req.on('error', e => cb(e));
  req.write(payload);
  req.end();
}

// Accepted share -> append to the rolling window and bump counters. NO hashrate is
// computed here; the sweeper owns the hashrate column. This keeps recordShare O(1) and
// makes the recorded rate a true live-decaying window instead of a stale EWMA.
function recordShare(login, shareDiff) {
  const key = (login || '').toLowerCase();
  const info = authCache[key];
  const account_id = info ? info.account_id : null;
  const now = Date.now();
  const diff = parseFloat(shareDiff) || 0;
  lastShareTs[key] = now;
  (shareEvents[key] || (shareEvents[key] = [])).push({ ts: now, diff: diff });
  const iso = new Date(now).toISOString();
  db.prepare(
    `INSERT INTO pool_worker_stats
       (worker_key, account_id, hashrate, shares_valid, shares_stale, online, last_share_at)
     VALUES (?,?,0,1,0,1,?)
     ON CONFLICT(worker_key) DO UPDATE SET
       account_id    = excluded.account_id,
       shares_valid  = pool_worker_stats.shares_valid + 1,
       online        = 1,
       last_share_at = excluded.last_share_at`
  ).run(key, account_id, iso);
  db.prepare('UPDATE pool_round SET round_shares = round_shares + ? WHERE id=1')
    .run(diff);
}

function recordStale(login) {
  const key = (login || '').toLowerCase();
  db.prepare(
    `INSERT INTO pool_worker_stats (worker_key, hashrate, shares_valid, shares_stale, online)
     VALUES (?,0,0,1,1)
     ON CONFLICT(worker_key) DO UPDATE SET
       shares_stale = pool_worker_stats.shares_stale + 1`
  ).run(key);
}

// Periodic sweeper: recompute the windowed hashrate for every known worker, prune stale
// events, and demote idle workers (online=0, hashrate=0). Runs over the DB row set so a
// worker that simply STOPPED submitting (no more recordShare calls) is still decayed to
// zero within ~IDLE_SEC. `nowMs` is injectable for deterministic tests.
function sweep(nowMs) {
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const rows = db.prepare('SELECT worker_key, last_share_at FROM pool_worker_stats').all();
  const upd = db.prepare('UPDATE pool_worker_stats SET hashrate=?, online=? WHERE worker_key=?');
  const apply = db.transaction(function (list) {
    for (let i = 0; i < list.length; i++) {
      const key = list[i].worker_key;
      const events = shareEvents[key];
      const lastMs = lastShareTs[key] || Date.parse(list[i].last_share_at) || 0;
      const r = hr.evaluateWorker(events, lastMs, now, { windowSec: WINDOW_SEC, idleSec: IDLE_SEC, mult: SCRYPT_MULT });
      if (r.online === 0 && events) delete shareEvents[key]; // release memory for offline workers
      upd.run(r.hashrate, r.online, key);
    }
  });
  apply(rows);
  return rows.length;
}

let sweepTimer = null;
function startSweeper() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(function () {
    try { sweep(); } catch (e) { process.stderr.write('portal_bridge sweep err ' + e.message + '\n'); }
  }, SWEEP_INT_MS);
  if (sweepTimer.unref) sweepTimer.unref(); // never keep the process alive on the sweeper alone
  return sweepTimer;
}
function stopSweeper() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

// Auto-start under the pool daemon; tests set BRIDGE_NO_AUTOSWEEP=1 and drive sweep() directly.
if (!process.env.BRIDGE_NO_AUTOSWEEP) startSweeper();

// Block found -> record block, reset round, credit miner (98%) as a pending payout.
// The 2% dev-fee is enforced in the coinbase by rewardRecipients; here it is the
// reward_tfx (total) minus the credited amount.
function recordBlock(height, hash, login, blockRewardSat) {
  const key = (login || '').toLowerCase();
  const info = authCache[key] || {};
  const total = (parseInt(blockRewardSat, 10) || 0) / 1e8;
  const iso = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO pool_blocks (height, hash, finder_worker, reward_tfx, status, found_at)
     VALUES (?,?,?,?, 'pending', ?)`
  ).run(height, hash, key, total, iso);
  db.prepare('UPDATE pool_round SET round_shares = 0, started_at = ? WHERE id=1').run(iso);

  const account_id = info.account_id || null;
  const worker = info.worker || (key.split('.')[1] || '');
  if (account_id) {
    const credit = total * (1 - DEV_FEE);   // single-account PPLNS -> all 98% here
    db.prepare(
      `INSERT INTO pool_payouts (account_id, worker_name, amount_tfx, block_height, status, created_at)
       VALUES (?,?,?,?, 'pending', ?)`
    ).run(account_id, worker, credit, height, iso);
  }
}

module.exports = {
  workerAuth, recordShare, recordStale, recordBlock,
  sweep, startSweeper, stopSweeper,
  authCache, shareEvents, lastShareTs, db, DEV_FEE,
  WINDOW_SEC, IDLE_SEC, SCRYPT_MULT
};
