'use strict';
// Pool-side ingest client: the spool DB + the flusher loop.
//
// The spool DB is the pool's OWN ledger and its retry journal. `portal_bridge.js`
// (shares/blocks/payouts) and `payout_monitor.py` (confirm/paid + txid) both WRITE
// to it locally; mining never blocks on the portal. A single flusher loop is the
// ONE network writer: every ~10s it POSTs an absolute stats snapshot, then unsynced
// blocks, then unsynced payouts (order matters — the portal requires a payout's
// block to exist first) to the production backend's /api/portal/ingest/* endpoints,
// and marks rows synced only on a per-item ack. A portal outage of any length loses
// nothing; stats are last-write-wins so gaps self-heal on the first good flush.
//
// Config (systemd EnvironmentFile=/opt/tfxpool/pool.env, 600, git-ignored):
//   PORTAL_BASE_URL   e.g. https://tracercoin.org
//   POOL_INGEST_TOKEN the ingest secret (separate from POOL_INTERNAL_TOKEN)
//   SPOOL_DB          e.g. /var/lib/tfxpool/spool.db

const https = require('https');
const http = require('http');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SPOOL_DB     = process.env.SPOOL_DB || '/var/lib/tfxpool/spool.db';
const PORTAL_BASE  = process.env.PORTAL_BASE_URL || 'https://tracercoin.org';
const INGEST_TOKEN = process.env.POOL_INGEST_TOKEN || '';
const IDLE_MS      = 90 * 1000;       // worker idle > 90s => online=false (cutover §1.3)
const FLUSH_MS     = 10 * 1000;       // base flush cadence
const BACKOFF_MAX  = 60 * 1000;       // backoff cap on portal failure
const REQ_TIMEOUT  = 5 * 1000;        // per-request timeout
const BATCH        = 500;             // max block/payout rows per request

function ts() { return new Date().toISOString(); }
function log() { process.stdout.write(ts() + ' [ingest] ' + [].slice.call(arguments).join(' ') + '\n'); }

// --- spool DB (WAL; shared with payout_monitor.py) -------------------------
try { fs.mkdirSync(path.dirname(SPOOL_DB), { recursive: true }); } catch (e) { /* exists */ }
const spool = new Database(SPOOL_DB);
spool.pragma('journal_mode = WAL');
spool.pragma('busy_timeout = 5000');

spool.exec(`
  CREATE TABLE IF NOT EXISTS spool_worker_stats (
    worker_key    TEXT PRIMARY KEY,
    account_id    INTEGER,
    hashrate      REAL    NOT NULL DEFAULT 0,   -- H/s (EWMA)
    shares_valid  INTEGER NOT NULL DEFAULT 0,   -- absolute lifetime counters
    shares_stale  INTEGER NOT NULL DEFAULT 0,
    last_share_ms INTEGER,                       -- epoch ms of last accepted share (idle calc)
    last_share_at TEXT
  );
  CREATE TABLE IF NOT EXISTS spool_blocks (
    height        INTEGER PRIMARY KEY,
    hash          TEXT,
    finder_worker TEXT,
    reward_tfx    REAL    NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT 'pending',   -- pending|confirmed|orphan
    found_at      TEXT    NOT NULL,
    synced        INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS spool_payouts (
    pool_ref       TEXT PRIMARY KEY,               -- <height>:<account_id>:<worker>
    account_id     INTEGER,
    worker_name    TEXT,
    amount_tfx     REAL    NOT NULL,
    block_height   INTEGER,
    payout_address TEXT,                            -- pool-local; NOT sent to the portal
    status         TEXT    NOT NULL DEFAULT 'pending',  -- pending|paid
    txid           TEXT,
    created_at     TEXT    NOT NULL,
    paid_at        TEXT,
    synced         INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS spool_round (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    round_shares   REAL NOT NULL DEFAULT 0,
    network_target REAL NOT NULL DEFAULT 0,
    started_at     TEXT
  );
`);

function ensureRound() {
  const r = spool.prepare('SELECT id FROM spool_round WHERE id = 1').get();
  if (!r) {
    spool.prepare('INSERT INTO spool_round (id, round_shares, network_target, started_at) VALUES (1,0,?,?)')
      .run(1000, ts());
  }
}
ensureRound();

// --- HTTP POST helper (https/http per PORTAL_BASE_URL; 5s timeout) ----------
function postJSON(pathname, obj) {
  return new Promise(function (resolve, reject) {
    let base;
    try { base = new URL(PORTAL_BASE); } catch (e) { return reject(new Error('bad PORTAL_BASE_URL')); }
    const payload = Buffer.from(JSON.stringify(obj));
    const mod = base.protocol === 'http:' ? http : https;
    const req = mod.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (base.protocol === 'http:' ? 80 : 443),
      path: pathname,
      method: 'POST',
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
          try { resolve(JSON.parse(body || '{}')); }
          catch (e) { reject(new Error('bad JSON from ' + pathname)); }
        } else {
          reject(new Error(pathname + ' HTTP ' + res.statusCode + ' ' + body.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(REQ_TIMEOUT, function () { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// --- snapshot builders ------------------------------------------------------
function buildStatsSnapshot() {
  const now = Date.now();
  const rows = spool.prepare(
    'SELECT worker_key, account_id, hashrate, shares_valid, shares_stale, last_share_ms, last_share_at FROM spool_worker_stats'
  ).all();
  const workers = rows.map(function (r) {
    const online = r.last_share_ms != null && (now - r.last_share_ms) <= IDLE_MS;
    return {
      worker_key: r.worker_key,
      account_id: r.account_id,
      hashrate: online ? r.hashrate : 0,   // zero the displayed rate for idle workers
      shares_valid: r.shares_valid,
      shares_stale: r.shares_stale,
      online: online,
      last_share_at: r.last_share_at
    };
  });
  const rnd = spool.prepare('SELECT round_shares, network_target, started_at FROM spool_round WHERE id = 1').get() || {};
  return {
    sent_at: ts(),
    workers: workers,
    round: {
      round_shares: rnd.round_shares || 0,
      network_target: rnd.network_target || 0,
      started_at: rnd.started_at || null
    }
  };
}

// --- one flush pass (throws on any network failure -> caller backs off) -----
async function flushOnce() {
  if (!INGEST_TOKEN) { log('POOL_INGEST_TOKEN not set — skipping flush'); return; }

  // 1) absolute stats snapshot (idempotent, last-write-wins)
  await postJSON('/api/portal/ingest/stats', buildStatsSnapshot());

  // 2) unsynced blocks (ascending height so payouts can reference them next)
  const blocks = spool.prepare(
    "SELECT height, hash, finder_worker, reward_tfx, status, found_at FROM spool_blocks WHERE synced = 0 ORDER BY height ASC LIMIT ?"
  ).all(BATCH);
  if (blocks.length) {
    const resp = await postJSON('/api/portal/ingest/blocks', { blocks: blocks });
    const applied = new Set(resp.applied || []);
    const mark = spool.prepare('UPDATE spool_blocks SET synced = 1 WHERE height = ?');
    const tx = spool.transaction(function (hs) { hs.forEach(h => mark.run(h)); });
    tx(blocks.map(b => b.height).filter(h => applied.has(h)));
    if (resp.rejected && resp.rejected.length) log('blocks rejected: ' + JSON.stringify(resp.rejected));
  }

  // 3) unsynced payouts (payout_address is pool-local; not sent to the portal)
  const payouts = spool.prepare(
    "SELECT pool_ref, account_id, worker_name, amount_tfx, block_height, status, txid, created_at, paid_at FROM spool_payouts WHERE synced = 0 ORDER BY block_height ASC LIMIT ?"
  ).all(BATCH);
  if (payouts.length) {
    const resp = await postJSON('/api/portal/ingest/payouts', { payouts: payouts });
    const applied = new Set(resp.applied || []);
    const mark = spool.prepare('UPDATE spool_payouts SET synced = 1 WHERE pool_ref = ?');
    const tx = spool.transaction(function (refs) { refs.forEach(r => mark.run(r)); });
    tx(payouts.map(p => p.pool_ref).filter(r => applied.has(r)));
    if (resp.rejected && resp.rejected.length) log('payouts rejected: ' + JSON.stringify(resp.rejected));
  }
}

// --- flusher loop with exponential backoff on failure -----------------------
let _delay = FLUSH_MS;
let _running = false;
async function tick() {
  try {
    await flushOnce();
    _delay = FLUSH_MS;                 // recovered — back to base cadence
  } catch (e) {
    _delay = Math.min(BACKOFF_MAX, Math.max(FLUSH_MS, _delay * 2));
    log('flush failed (' + e.message + ') — retry in ' + Math.round(_delay / 1000) + 's');
  } finally {
    setTimeout(tick, _delay);
  }
}

function startFlusher() {
  if (_running) return;
  _running = true;
  log('flusher started base=' + FLUSH_MS + 'ms portal=' + PORTAL_BASE + ' spool=' + SPOOL_DB);
  setTimeout(tick, _delay);
}

// Auto-start when loaded by the pool (init.js -> portal_bridge -> here), but stay
// quiet under `node --check` / unit tests via INGEST_NO_FLUSH=1.
if (!process.env.INGEST_NO_FLUSH) {
  startFlusher();
}

module.exports = { spool, ensureRound, buildStatsSnapshot, flushOnce, startFlusher, IDLE_MS };
