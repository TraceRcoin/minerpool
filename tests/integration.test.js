'use strict';
// DB-backed integration tests for the pool stats writers, run with:  node --test
// Exercises portal_bridge.js (immediate fix, writes pool_* into the portal DB) and
// ingest_client.js (strategic spool + snapshot) against real better-sqlite3 databases.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tfxpool-'));
const bridgeDb = path.join(tmp, 'portal.db');
const spoolDb = path.join(tmp, 'spool.db');

// portal_bridge.js only INSERTs into pool_* — the tables belong to the portal, so seed them.
const seed = new Database(bridgeDb);
seed.exec(`
  CREATE TABLE pool_worker_stats (worker_key TEXT PRIMARY KEY, account_id INTEGER, hashrate REAL DEFAULT 0,
    shares_valid INTEGER DEFAULT 0, shares_stale INTEGER DEFAULT 0, online INTEGER DEFAULT 0, last_share_at TEXT);
  CREATE TABLE pool_round (id INTEGER PRIMARY KEY, round_shares REAL, network_target REAL, started_at TEXT);
  CREATE TABLE pool_blocks (height INTEGER PRIMARY KEY, hash TEXT, finder_worker TEXT, reward_tfx REAL, status TEXT, found_at TEXT);
  CREATE TABLE pool_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, worker_name TEXT,
    amount_tfx REAL, block_height INTEGER, status TEXT, created_at TEXT);
`);
seed.close();

process.env.STAGING_DB = bridgeDb;
process.env.BRIDGE_NO_AUTOSWEEP = '1'; // drive sweep() manually with an injected clock
process.env.SPOOL_DB = spoolDb;

const bridge = require('../portal_bridge.js');
const ingest = require('../ingest_client.js');

const MULT = 65536, WINDOW = 300;

test('portal_bridge: recordShare no longer writes hashrate; sweeper computes the window', () => {
  const login = 'tracerfx123.rig01';
  bridge.authCache[login] = { account_id: 7, worker: 'rig01' };
  for (let i = 0; i < 82; i++) bridge.recordShare(login, 8); // ~real 144 kH/s worth of diff-8 shares

  // Before any sweep, hashrate must be 0 (recordShare does not set it).
  let row = bridge.db.prepare('SELECT hashrate, shares_valid, online FROM pool_worker_stats WHERE worker_key=?').get(login);
  assert.strictEqual(row.hashrate, 0, 'recordShare must not write hashrate');
  assert.strictEqual(row.shares_valid, 82);

  const now = Date.now();
  bridge.sweep(now);
  row = bridge.db.prepare('SELECT hashrate, online FROM pool_worker_stats WHERE worker_key=?').get(login);
  const expected = (82 * 8 * MULT) / WINDOW; // ~143.3 kH/s
  assert.strictEqual(row.online, 1);
  assert.ok(Math.abs(row.hashrate - expected) < 1, 'hashrate ' + row.hashrate);
  assert.ok(row.hashrate < 200000, 'must not inflate ~4x: ' + row.hashrate);

  // round_shares accumulated the shareDiff sum.
  const rs = bridge.db.prepare('SELECT round_shares FROM pool_round WHERE id=1').get().round_shares;
  assert.strictEqual(rs, 82 * 8);
});

test('portal_bridge: a stopped worker decays to online=0 / hashrate=0 within the idle window', () => {
  const login = 'tracerfx123.rig01';
  const now = Date.now();
  bridge.sweep(now + 200000); // 200s after the last share (> 90s idle)
  const row = bridge.db.prepare('SELECT hashrate, online FROM pool_worker_stats WHERE worker_key=?').get(login);
  assert.strictEqual(row.online, 0);
  assert.strictEqual(row.hashrate, 0);
});

test('ingest_client: buildStatsSnapshot returns windowed hashrate + online flag', () => {
  const login = 'tracerfx123.rig02';
  ingest.setAuth(login, { account_id: 7, worker: 'rig02' });
  for (let i = 0; i < 50; i++) ingest.recordShare(login, 8);

  const now = Date.now();
  const snap = ingest.buildStatsSnapshot(now);
  const w = snap.workers.find(x => x.worker_key === login);
  assert.ok(w, 'worker present in snapshot');
  assert.strictEqual(w.online, true);
  assert.strictEqual(w.shares_valid, 50);
  const expected = (50 * 8 * MULT) / WINDOW;
  assert.ok(Math.abs(w.hashrate - expected) < 1, 'hashrate ' + w.hashrate);
});

test('ingest_client: idle worker snapshot is offline with 0 hashrate and its shares are pruned', () => {
  const login = 'tracerfx123.rig02';
  const now = Date.now();
  const snap = ingest.buildStatsSnapshot(now + 400000); // 400s later: idle AND past the window
  const w = snap.workers.find(x => x.worker_key === login);
  assert.strictEqual(w.online, false);
  assert.strictEqual(w.hashrate, 0);
  const remaining = ingest.db.prepare('SELECT COUNT(*) c FROM spool_shares WHERE worker_key=?').get(login).c;
  assert.strictEqual(remaining, 0, 'aged-out shares pruned');
});

test('ingest_client: recordBlock spools a block + a 98% pending payout with a deterministic pool_ref', () => {
  const login = 'tracerfx123.rig03';
  ingest.setAuth(login, { account_id: 7, worker: 'rig03' });
  ingest.recordBlock(42, 'a'.repeat(64), login, 40000000000); // 400 TFX in sats
  const blk = ingest.db.prepare('SELECT reward_tfx, status, synced FROM spool_blocks WHERE height=42').get();
  assert.strictEqual(blk.reward_tfx, 400);
  assert.strictEqual(blk.synced, 0);
  const pay = ingest.db.prepare("SELECT amount_tfx, status FROM spool_payouts WHERE pool_ref=?").get('42:7:rig03');
  assert.ok(pay, 'payout row keyed by pool_ref');
  assert.ok(Math.abs(pay.amount_tfx - 400 * 0.98) < 1e-9, 'credit ' + pay.amount_tfx);
});
