'use strict';
// Pool-side bridge: authorizes rigs against the miner portal's /api/portal/worker-auth
// and writes live pool_* stats/blocks/payouts into the (co-located) portal SQLite.
//
// STAGING build. To point at production, change PORTAL_HOST/PORTAL_PORT (or the base
// URL) and STAGING_DB to the production portal + its DB path, and supply the prod
// POOL_INTERNAL_TOKEN via the environment. Nothing else here is environment-specific.

const http = require('http');
const Database = require('better-sqlite3');

const DB_PATH      = process.env.STAGING_DB || '/var/lib/tfx-staging/portal.db';
const PORTAL_HOST  = process.env.PORTAL_HOST || '127.0.0.1';
const PORTAL_PORT  = parseInt(process.env.PORTAL_PORT || '8090', 10);
const AUTH_PATH    = '/api/portal/worker-auth';
const POOL_TOKEN   = process.env.POOL_INTERNAL_TOKEN || '';
const DEV_FEE      = 0.02;                 // 2% dev-fee skim (matches rewardRecipients)
const SCRYPT_MULT  = Math.pow(2, 16);      // rough H/s scaling from scrypt share diff

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// login (lowercase 'account.worker') -> {account_id, payout_address, username, worker}
const authCache = {};
const lastShareTs = {};

// Orphan-safe / idempotent ledger guards (mirrors production-cutover.md §1.2 & §1.4).
// The pool writes to a co-located SQLite whose schema is owned by the portal copy;
// these guards are additive and safe to run on every boot (IF NOT EXISTS / column probe):
//   - pool_payouts gets a deterministic `pool_ref` (`height:account_id:worker`) with a
//     UNIQUE index so a stale/orphan sibling at the same height cannot create a second
//     credit for the same worker (ON CONFLICT(pool_ref) DO NOTHING in recordBlock).
//   - pool_blocks keeps its height PK; recordBlock switches from INSERT OR REPLACE to
//     ON CONFLICT(height) DO NOTHING so an orphan can never overwrite the first winner.
function ensureLedgerGuards() {
  const cols = db.prepare('PRAGMA table_info(pool_payouts)').all();
  const hasRef = cols.some(c => c.name === 'pool_ref');
  if (!hasRef) {
    db.exec('ALTER TABLE pool_payouts ADD COLUMN pool_ref TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_payouts_ref ON pool_payouts(pool_ref)');
}
ensureLedgerGuards();

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

// Accepted share -> bump per-worker stats + round shares.
function recordShare(login, shareDiff) {
  const key = (login || '').toLowerCase();
  const info = authCache[key];
  const account_id = info ? info.account_id : null;
  const now = Date.now();
  const prev = lastShareTs[key] || (now - 15000);
  const dt = Math.max(1, (now - prev) / 1000);
  lastShareTs[key] = now;
  const hr = (parseFloat(shareDiff) * SCRYPT_MULT) / dt;   // rough H/s estimate
  const iso = new Date().toISOString();
  db.prepare(
    `INSERT INTO pool_worker_stats
       (worker_key, account_id, hashrate, shares_valid, shares_stale, online, last_share_at)
     VALUES (?,?,?,1,0,1,?)
     ON CONFLICT(worker_key) DO UPDATE SET
       account_id    = excluded.account_id,
       hashrate      = (pool_worker_stats.hashrate*0.7 + excluded.hashrate*0.3),
       shares_valid  = pool_worker_stats.shares_valid + 1,
       online        = 1,
       last_share_at = excluded.last_share_at`
  ).run(key, account_id, hr, iso);
  db.prepare('UPDATE pool_round SET round_shares = round_shares + ? WHERE id=1')
    .run(parseFloat(shareDiff) || 0);
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

// Block found -> record block, reset round, credit miner (98%) as a pending payout.
// The 2% dev-fee is enforced in the coinbase by rewardRecipients; here it is the
// reward_tfx (total) minus the credited amount.
// Deterministic idempotency key for a block credit: `height:account_id:worker`.
// A stale/orphan sibling found for the same height by the same account+worker maps to
// the same ref, so ON CONFLICT(pool_ref) DO NOTHING keeps exactly one credit.
function payoutRef(height, account_id, worker) {
  return height + ':' + account_id + ':' + (worker || '');
}

function recordBlock(height, hash, login, blockRewardSat) {
  const key = (login || '').toLowerCase();
  const info = authCache[key] || {};
  const total = (parseInt(blockRewardSat, 10) || 0) / 1e8;
  const iso = new Date().toISOString();
  // Keep the FIRST block recorded at this height. An orphaned sibling that arrives
  // second must never overwrite the winner, so DO NOTHING on the height conflict
  // (replaces the old INSERT OR REPLACE, which let the loser clobber the winner's
  // hash/finder/reward). Whether this height ultimately confirms is decided later by
  // payout_monitor against the daemon's active chain.
  db.prepare(
    `INSERT INTO pool_blocks (height, hash, finder_worker, reward_tfx, status, found_at)
     VALUES (?,?,?,?, 'pending', ?)
     ON CONFLICT(height) DO NOTHING`
  ).run(height, hash, key, total, iso);
  db.prepare('UPDATE pool_round SET round_shares = 0, started_at = ? WHERE id=1').run(iso);

  const account_id = info.account_id || null;
  const worker = info.worker || (key.split('.')[1] || '');
  if (account_id) {
    const credit = total * (1 - DEV_FEE);   // single-account PPLNS -> all 98% here
    // Idempotent credit: a second recordBlock for the same height+account+worker
    // (the fork17 double-report) is a no-op, so a sibling cannot mint a second payout.
    db.prepare(
      `INSERT INTO pool_payouts (account_id, worker_name, amount_tfx, block_height, status, created_at, pool_ref)
       VALUES (?,?,?,?, 'pending', ?, ?)
       ON CONFLICT(pool_ref) DO NOTHING`
    ).run(account_id, worker, credit, height, iso, payoutRef(height, account_id, worker));
  }
}

module.exports = { workerAuth, recordShare, recordStale, recordBlock, payoutRef, authCache, db, DEV_FEE };
