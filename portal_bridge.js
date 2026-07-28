'use strict';
// Pool-side bridge: authorizes rigs against the miner portal's /api/portal/worker-auth
// (over HTTPS) and records live pool_* stats/blocks/payouts into the LOCAL spool DB.
//
// The spool DB (owned by ingest_client.js) is the pool's own ledger; a single flusher
// there syncs it to the production portal's /api/portal/ingest/* endpoints. Nothing
// here writes to the portal DB directly anymore, and mining never blocks on the portal.
//
// PRODUCTION build. Config via env (systemd EnvironmentFile=/opt/tfxpool/pool.env):
//   PORTAL_BASE_URL     e.g. https://tracercoin.org   (worker-auth + ingest share this)
//   POOL_INTERNAL_TOKEN the worker-auth shared secret
//   POOL_INGEST_TOKEN   the ingest secret (used by ingest_client.js)
//   SPOOL_DB            the local spool DB path (used by ingest_client.js)

const https = require('https');
const http = require('http');
const { URL } = require('url');

// The spool DB + flusher live in ingest_client; requiring it also starts the flusher.
const { spool } = require('./ingest_client');

const PORTAL_BASE = process.env.PORTAL_BASE_URL || 'https://tracercoin.org';
const AUTH_PATH   = '/api/portal/worker-auth';
const POOL_TOKEN  = process.env.POOL_INTERNAL_TOKEN || '';
const DEV_FEE     = 0.02;                 // 2% dev-fee skim (matches rewardRecipients)
const SCRYPT_MULT = Math.pow(2, 16);      // rough H/s scaling from scrypt share diff
const AUTH_TIMEOUT = 5 * 1000;            // §2.1: 5s timeout, one retry after 1s

// login (lowercase 'account.worker') -> {account_id, payout_address, username, worker}
const authCache = {};
const lastShareTs = {};

function ensureRound() {
  const r = spool.prepare('SELECT id FROM spool_round WHERE id=1').get();
  if (!r) {
    spool.prepare('INSERT INTO spool_round (id, round_shares, network_target, started_at) VALUES (1,0,?,?)')
      .run(1000, new Date().toISOString());
  }
}
ensureRound();

// POST {login,password} with X-Pool-Token over HTTPS; cache the resolved account on
// success. One retry after 1s on a network/timeout error (auth is at rig-connect time,
// not per-share, so the latency is cheap).
function workerAuth(login, password, cb) {
  const key = (login || '').toLowerCase();
  const payload = Buffer.from(JSON.stringify({ login: key, password: password }));

  let base;
  try { base = new URL(PORTAL_BASE); } catch (e) { return cb(new Error('bad PORTAL_BASE_URL')); }
  const mod = base.protocol === 'http:' ? http : https;

  function attempt(retriesLeft) {
    let settled = false;
    const done = (err, info) => { if (!settled) { settled = true; cb(err, info); } };

    const req = mod.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (base.protocol === 'http:' ? 80 : 443),
      path: AUTH_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
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
            done(null, authCache[key]);
          } catch (e) { done(e); }
        } else {
          // A definitive rejection (401/403) is NOT retried; it means bad creds.
          done(new Error('worker-auth HTTP ' + res.statusCode));
        }
      });
    });
    req.on('error', function (e) {
      if (retriesLeft > 0) { setTimeout(() => attempt(retriesLeft - 1), 1000); }
      else { done(e); }
    });
    req.setTimeout(AUTH_TIMEOUT, function () { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  }
  attempt(1);
}

// Accepted share -> bump per-worker stats (absolute counters) + round shares, in the
// LOCAL spool DB. `last_share_ms` drives the flusher's idle/offline demotion.
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
  spool.prepare(
    `INSERT INTO spool_worker_stats
       (worker_key, account_id, hashrate, shares_valid, shares_stale, last_share_ms, last_share_at)
     VALUES (?,?,?,1,0,?,?)
     ON CONFLICT(worker_key) DO UPDATE SET
       account_id    = excluded.account_id,
       hashrate      = (spool_worker_stats.hashrate*0.7 + excluded.hashrate*0.3),
       shares_valid  = spool_worker_stats.shares_valid + 1,
       last_share_ms = excluded.last_share_ms,
       last_share_at = excluded.last_share_at`
  ).run(key, account_id, hr, now, iso);
  spool.prepare('UPDATE spool_round SET round_shares = round_shares + ? WHERE id=1')
    .run(parseFloat(shareDiff) || 0);
}

function recordStale(login) {
  const key = (login || '').toLowerCase();
  spool.prepare(
    `INSERT INTO spool_worker_stats (worker_key, hashrate, shares_valid, shares_stale)
     VALUES (?,0,0,1)
     ON CONFLICT(worker_key) DO UPDATE SET
       shares_stale = spool_worker_stats.shares_stale + 1`
  ).run(key);
}

// Block found -> record block (pending), reset round, credit miner (98%) as a pending
// payout keyed by the deterministic pool_ref. The 2% dev-fee is enforced in the
// coinbase by rewardRecipients; here reward_tfx is the full block reward and the
// credited amount is 98% of it. `synced=0` marks both rows for the flusher.
function recordBlock(height, hash, login, blockRewardSat) {
  const key = (login || '').toLowerCase();
  const info = authCache[key] || {};
  const total = (parseInt(blockRewardSat, 10) || 0) / 1e8;
  const iso = new Date().toISOString();
  spool.prepare(
    `INSERT INTO spool_blocks (height, hash, finder_worker, reward_tfx, status, found_at, synced)
     VALUES (?,?,?,?, 'pending', ?, 0)
     ON CONFLICT(height) DO UPDATE SET
       hash          = excluded.hash,
       finder_worker = excluded.finder_worker,
       reward_tfx    = excluded.reward_tfx,
       found_at      = excluded.found_at,
       synced        = 0`
  ).run(height, hash, key, total, iso);
  spool.prepare('UPDATE spool_round SET round_shares = 0, started_at = ? WHERE id=1').run(iso);

  const account_id = info.account_id || null;
  const worker = info.worker || (key.split('.')[1] || '');
  if (account_id) {
    const credit = total * (1 - DEV_FEE);   // single-account PPLNS -> all 98% here
    const poolRef = height + ':' + account_id + ':' + worker;
    spool.prepare(
      `INSERT INTO spool_payouts
         (pool_ref, account_id, worker_name, amount_tfx, block_height, payout_address, status, created_at, synced)
       VALUES (?,?,?,?,?,?, 'pending', ?, 0)
       ON CONFLICT(pool_ref) DO NOTHING`
    ).run(poolRef, account_id, worker, credit, height, info.payout_address || null, iso);
  }
}

module.exports = { workerAuth, recordShare, recordStale, recordBlock, authCache, spool, DEV_FEE };
