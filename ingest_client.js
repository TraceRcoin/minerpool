'use strict';
// ingest_client.js — strategic home for the windowed-hashrate + idle logic
// (production-cutover.md §1.3, Decision 1 option A: authenticated ingest API).
//
// Instead of writing pool_* rows into a co-located portal SQLite (portal_bridge.js), the
// pool records shares/blocks/payouts into a LOCAL spool DB and a background flusher (every
// FLUSH_INTERVAL_MS, default 10s) builds an ABSOLUTE worker-stats snapshot and POSTs it to
// the production portal's new /api/portal/ingest/stats. The snapshot carries the same
// windowed, count-based hashrate and idle zeroing as portal_bridge.js (shared hashrate.js),
// so this fixes the ~4x inflation / no-decay bug AND the cross-box sync gap together.
//
//   * Mining never blocks on the portal — recordShare/recordStale/recordBlock only touch
//     the local spool; the flusher does the network I/O and retries.
//   * Snapshots are last-write-wins absolute values (idempotent), so a portal outage of any
//     length self-heals on the first good flush.
//   * recordShare/recordStale/recordBlock keep the exact signatures init.js already calls,
//     so switching the pool from portal_bridge.js to ingest_client.js is a require() change.
//
// This module is the cutover target; it is NOT yet wired into init.js (that swap belongs to
// the Phase C production-cutover work). It is committed here so the hashrate fix lands in its
// final home and can be reviewed alongside the portal_bridge.js immediate fix.

const https = require('https');
const http = require('http');
const { URL } = require('url');
const Database = require('better-sqlite3');
const hr = require('./hashrate.js');

const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL || 'https://tracercoin.org';
const INGEST_TOKEN    = process.env.POOL_INGEST_TOKEN || '';
const SPOOL_DB        = process.env.SPOOL_DB || '/var/lib/tfxpool/spool.db';
const DEV_FEE         = 0.02;
const SCRYPT_MULT     = hr.SCRYPT_MULT;                                                 // 2^16, matches engine
const WINDOW_SEC      = parseInt(process.env.HASHRATE_WINDOW_SEC || String(hr.WINDOW_SEC), 10);
const IDLE_SEC        = parseInt(process.env.IDLE_TIMEOUT_SEC     || String(hr.IDLE_SEC), 10);
const FLUSH_INT_MS    = parseInt(process.env.FLUSH_INTERVAL_MS    || '10000', 10);      // §1.3: 10s flusher
const REQ_TIMEOUT_MS  = parseInt(process.env.INGEST_TIMEOUT_MS    || '5000', 10);
const BACKOFF_MIN_MS  = 10000;
const BACKOFF_MAX_MS  = 60000;

const db = new Database(SPOOL_DB);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS spool_worker_stats (
    worker_key    TEXT PRIMARY KEY,
    account_id    INTEGER,
    hashrate      REAL    DEFAULT 0,
    shares_valid  INTEGER DEFAULT 0,
    shares_stale  INTEGER DEFAULT 0,
    online        INTEGER DEFAULT 0,
    last_share_at TEXT
  );
  CREATE TABLE IF NOT EXISTS spool_shares (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_key TEXT NOT NULL,
    ts         INTEGER NOT NULL,   -- epoch ms
    diff       REAL    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spool_shares_wk_ts ON spool_shares(worker_key, ts);
  CREATE TABLE IF NOT EXISTS spool_round (
    id INTEGER PRIMARY KEY CHECK (id=1),
    round_shares REAL DEFAULT 0,
    network_target REAL DEFAULT 0,
    started_at TEXT
  );
  CREATE TABLE IF NOT EXISTS spool_blocks (
    height        INTEGER PRIMARY KEY,
    hash          TEXT,
    finder_worker TEXT,
    reward_tfx    REAL,
    status        TEXT DEFAULT 'pending',
    found_at      TEXT,
    synced        INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS spool_payouts (
    pool_ref     TEXT PRIMARY KEY,
    account_id   INTEGER,
    worker_name  TEXT,
    amount_tfx   REAL,
    block_height INTEGER,
    status       TEXT DEFAULT 'pending',
    created_at   TEXT,
    txid         TEXT,
    paid_at      TEXT,
    synced       INTEGER DEFAULT 0
  );
`);

function ensureRound() {
  const r = db.prepare('SELECT id FROM spool_round WHERE id=1').get();
  if (!r) {
    db.prepare('INSERT INTO spool_round (id, round_shares, network_target, started_at) VALUES (1,0,0,?)')
      .run(new Date().toISOString());
  }
}
ensureRound();

// worker-auth is still resolved by the pool at rig-connect time; the ingest client keeps a
// small account cache so recordBlock can attribute the payout. setAuth is called by whatever
// performs worker-auth (portal_bridge.workerAuth-style flow) at cutover.
const authCache = {};
function setAuth(login, info) { authCache[(login || '').toLowerCase()] = info; }

// --- record functions (same signatures init.js calls) -> local spool only ---

function recordShare(login, shareDiff) {
  const key = (login || '').toLowerCase();
  const info = authCache[key];
  const account_id = info ? info.account_id : null;
  const now = Date.now();
  const diff = parseFloat(shareDiff) || 0;
  db.prepare('INSERT INTO spool_shares (worker_key, ts, diff) VALUES (?,?,?)').run(key, now, diff);
  db.prepare(
    `INSERT INTO spool_worker_stats
       (worker_key, account_id, hashrate, shares_valid, shares_stale, online, last_share_at)
     VALUES (?,?,0,1,0,1,?)
     ON CONFLICT(worker_key) DO UPDATE SET
       account_id    = COALESCE(excluded.account_id, spool_worker_stats.account_id),
       shares_valid  = spool_worker_stats.shares_valid + 1,
       online        = 1,
       last_share_at = excluded.last_share_at`
  ).run(key, account_id, new Date(now).toISOString());
  db.prepare('UPDATE spool_round SET round_shares = round_shares + ? WHERE id=1').run(diff);
}

function recordStale(login) {
  const key = (login || '').toLowerCase();
  db.prepare(
    `INSERT INTO spool_worker_stats (worker_key, hashrate, shares_valid, shares_stale, online)
     VALUES (?,0,0,1,0)
     ON CONFLICT(worker_key) DO UPDATE SET
       shares_stale = spool_worker_stats.shares_stale + 1`
  ).run(key);
}

function recordBlock(height, hash, login, blockRewardSat) {
  const key = (login || '').toLowerCase();
  const info = authCache[key] || {};
  const total = (parseInt(blockRewardSat, 10) || 0) / 1e8;
  const iso = new Date().toISOString();
  db.prepare(
    `INSERT INTO spool_blocks (height, hash, finder_worker, reward_tfx, status, found_at, synced)
     VALUES (?,?,?,?, 'pending', ?, 0)
     ON CONFLICT(height) DO UPDATE SET
       hash=excluded.hash, finder_worker=excluded.finder_worker,
       reward_tfx=excluded.reward_tfx, found_at=excluded.found_at, synced=0`
  ).run(height, hash, key, total, iso);
  db.prepare('UPDATE spool_round SET round_shares = 0, started_at = ? WHERE id=1').run(iso);

  const account_id = info.account_id || null;
  const worker = info.worker || (key.split('.')[1] || '');
  if (account_id) {
    const credit = total * (1 - DEV_FEE);
    const pool_ref = height + ':' + account_id + ':' + worker; // deterministic (§1.4)
    db.prepare(
      `INSERT INTO spool_payouts (pool_ref, account_id, worker_name, amount_tfx, block_height, status, created_at, synced)
       VALUES (?,?,?,?,?, 'pending', ?, 0)
       ON CONFLICT(pool_ref) DO NOTHING`
    ).run(pool_ref, account_id, worker, credit, height, iso);
  }
}

// --- snapshot + flusher ---

// Build the absolute worker-stats snapshot: windowed hashrate per worker, idle zeroing,
// pruning of spool_shares older than the window. Also persists hashrate/online back into
// spool_worker_stats so the local ledger reflects the live figure. `nowMs` is injectable.
function buildStatsSnapshot(nowMs) {
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const cutoff = now - WINDOW_SEC * 1000;
  db.prepare('DELETE FROM spool_shares WHERE ts < ?').run(cutoff);

  const rows = db.prepare(
    'SELECT worker_key, account_id, shares_valid, shares_stale, last_share_at FROM spool_worker_stats'
  ).all();
  const sumStmt = db.prepare('SELECT COALESCE(SUM(diff),0) AS s FROM spool_shares WHERE worker_key=? AND ts >= ?');
  const upd = db.prepare('UPDATE spool_worker_stats SET hashrate=?, online=? WHERE worker_key=?');

  const workers = [];
  const apply = db.transaction(function (list) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const lastMs = r.last_share_at ? Date.parse(r.last_share_at) : 0;
      const idle = !lastMs || (now - lastMs) > IDLE_SEC * 1000;
      let hashrate = 0, online = 0;
      if (!idle) {
        const sum = sumStmt.get(r.worker_key, cutoff).s;
        hashrate = (sum * SCRYPT_MULT) / WINDOW_SEC;
        online = 1;
      }
      upd.run(hashrate, online, r.worker_key);
      workers.push({
        worker_key: r.worker_key,
        account_id: r.account_id,
        hashrate: hashrate,
        shares_valid: r.shares_valid,
        shares_stale: r.shares_stale,
        online: !!online,
        last_share_at: r.last_share_at
      });
    }
  });
  apply(rows);

  const round = db.prepare('SELECT round_shares, network_target, started_at FROM spool_round WHERE id=1').get() || null;
  return { sent_at: new Date(now).toISOString(), workers: workers, round: round };
}

function postJson(path, obj, cb) {
  let u;
  try { u = new URL(path, PORTAL_BASE_URL); } catch (e) { return cb(e); }
  const payload = Buffer.from(JSON.stringify(obj));
  const lib = (u.protocol === 'http:') ? http : https;
  const req = lib.request({
    protocol: u.protocol, hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + u.search, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
      'X-Pool-Token': INGEST_TOKEN
    }
  }, function (res) {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', function () {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        let j = null; try { j = JSON.parse(body); } catch (e) {}
        cb(null, j);
      } else {
        cb(new Error('ingest HTTP ' + res.statusCode));
      }
    });
  });
  req.setTimeout(REQ_TIMEOUT_MS, function () { req.destroy(new Error('ingest timeout')); });
  req.on('error', e => cb(e));
  req.write(payload);
  req.end();
}

function flushBlocks(cb) {
  const rows = db.prepare('SELECT * FROM spool_blocks WHERE synced=0 ORDER BY height LIMIT 500').all();
  if (!rows.length) return cb(null);
  const blocks = rows.map(r => ({
    height: r.height, hash: r.hash, finder_worker: r.finder_worker,
    reward_tfx: r.reward_tfx, status: r.status, found_at: r.found_at
  }));
  postJson('/api/portal/ingest/blocks', { blocks }, function (err) {
    if (err) return cb(err);
    const mark = db.prepare('UPDATE spool_blocks SET synced=1 WHERE height=?');
    const tx = db.transaction(list => list.forEach(r => mark.run(r.height)));
    tx(rows);
    cb(null);
  });
}

function flushPayouts(cb) {
  const rows = db.prepare('SELECT * FROM spool_payouts WHERE synced=0 ORDER BY block_height LIMIT 500').all();
  if (!rows.length) return cb(null);
  const payouts = rows.map(r => ({
    pool_ref: r.pool_ref, account_id: r.account_id, worker_name: r.worker_name,
    amount_tfx: r.amount_tfx, block_height: r.block_height, status: r.status,
    created_at: r.created_at, txid: r.txid, paid_at: r.paid_at
  }));
  postJson('/api/portal/ingest/payouts', { payouts }, function (err) {
    if (err) return cb(err);
    const mark = db.prepare('UPDATE spool_payouts SET synced=1 WHERE pool_ref=?');
    const tx = db.transaction(list => list.forEach(r => mark.run(r.pool_ref)));
    tx(rows);
    cb(null);
  });
}

let flushTimer = null;
let backoffMs = 0;

// One flush cycle: stats snapshot, then blocks, then payouts (order matters — a payout
// references a block that must exist portal-side first). On any failure, apply exponential
// backoff; the spool retains everything until acked, so nothing is lost.
function flush(done) {
  done = done || function () {};
  const snapshot = buildStatsSnapshot();
  postJson('/api/portal/ingest/stats', snapshot, function (err) {
    if (err) return fail(err, done);
    flushBlocks(function (err2) {
      if (err2) return fail(err2, done);
      flushPayouts(function (err3) {
        if (err3) return fail(err3, done);
        backoffMs = 0;
        done(null);
      });
    });
  });
}

function fail(err, done) {
  backoffMs = backoffMs ? Math.min(backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
  process.stderr.write('ingest flush failed (' + err.message + '), backoff ' + backoffMs + 'ms\n');
  done(err);
}

function start() {
  if (flushTimer) return flushTimer;
  const tick = function () {
    flush(function () {
      const delay = backoffMs || FLUSH_INT_MS;
      flushTimer = setTimeout(tick, delay);
      if (flushTimer.unref) flushTimer.unref();
    });
  };
  flushTimer = setTimeout(tick, FLUSH_INT_MS);
  if (flushTimer.unref) flushTimer.unref();
  return flushTimer;
}
function stop() { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } }

module.exports = {
  recordShare, recordStale, recordBlock, setAuth,
  buildStatsSnapshot, flush, start, stop,
  authCache, db, DEV_FEE, WINDOW_SEC, IDLE_SEC, SCRYPT_MULT
};
