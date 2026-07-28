'use strict';
// Fixture test for portal_bridge.js orphan-safe / idempotent ledger writes.
// Reproduces the height-17 "two blocks, same height" race and asserts the bridge
// records the block once and credits the miner once. Run: node tests/portal_bridge.test.js
//
// No portal HTTP is needed: recordBlock reads the resolved account from authCache,
// which we seed directly. We point the bridge at a throwaway SQLite that we pre-seed
// with the portal's pool_* schema, then require the module (it opens DB_PATH at load).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(os.tmpdir(), 'tfx_bridge_test_' + process.pid + '.db');
try { fs.unlinkSync(dbPath); } catch (e) {}

// Portal-owned schema (subset the bridge touches), per production-cutover.md §0.
const seed = new Database(dbPath);
seed.exec(`
  CREATE TABLE pool_blocks (
    height INTEGER PRIMARY KEY, hash TEXT, finder_worker TEXT,
    reward_tfx REAL, status TEXT, found_at TEXT);
  CREATE TABLE pool_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, worker_name TEXT,
    amount_tfx REAL, block_height INTEGER, status TEXT, created_at TEXT,
    txid TEXT, paid_at TEXT);
  CREATE TABLE pool_worker_stats (
    worker_key TEXT PRIMARY KEY, account_id INTEGER, hashrate REAL,
    shares_valid INTEGER, shares_stale INTEGER, online INTEGER, last_share_at TEXT);
  CREATE TABLE pool_round (
    id INTEGER PRIMARY KEY, round_shares REAL, network_target REAL, started_at TEXT);
`);
seed.close();

process.env.STAGING_DB = dbPath;
const bridge = require('../portal_bridge.js');

// Seed the resolved account for login "tracerfx123.rig01" (as worker-auth would).
bridge.authCache['tracerfx123.rig01'] = {
  account_id: 7, payout_address: 'tfx1qexample', username: 'tracerfx123', worker: 'rig01'
};

const REWARD_SAT = 400 * 1e8;                     // 400 TFX subsidy in sats
const EXPECT_CREDIT = 400 * (1 - bridge.DEV_FEE); // 98% -> 392

// --- payoutRef is deterministic ---
assert.strictEqual(bridge.payoutRef(17, 7, 'rig01'), '17:7:rig01', 'payoutRef shape');

// --- fork17: two candidates at height 17, different hashes, same finder ---
bridge.recordBlock(17, 'aaaa_hash_winner', 'tracerfx123.rig01', REWARD_SAT);
bridge.recordBlock(17, 'bbbb_hash_orphan', 'tracerfx123.rig01', REWARD_SAT); // sibling

const blocks = bridge.db.prepare('SELECT * FROM pool_blocks WHERE height=17').all();
assert.strictEqual(blocks.length, 1, 'exactly one block row at height 17');
assert.strictEqual(blocks[0].hash, 'aaaa_hash_winner',
  'first (winner) hash kept; orphan sibling did NOT overwrite it');

const payouts = bridge.db.prepare('SELECT * FROM pool_payouts WHERE block_height=17').all();
assert.strictEqual(payouts.length, 1, 'exactly one payout credit at height 17 (no double credit)');
assert.ok(Math.abs(payouts[0].amount_tfx - EXPECT_CREDIT) < 1e-6, 'credit is 98% of reward');
assert.strictEqual(payouts[0].pool_ref, '17:7:rig01', 'payout keyed on deterministic pool_ref');
assert.strictEqual(payouts[0].status, 'pending', 'payout starts pending (paid only after confirm)');

// --- replay safety: recording the same block again is a no-op ---
bridge.recordBlock(17, 'aaaa_hash_winner', 'tracerfx123.rig01', REWARD_SAT);
assert.strictEqual(bridge.db.prepare('SELECT COUNT(*) n FROM pool_payouts WHERE block_height=17').get().n, 1,
  'replaying the winning block does not create a second credit');
assert.strictEqual(bridge.db.prepare('SELECT COUNT(*) n FROM pool_blocks WHERE height=17').get().n, 1,
  'replaying the winning block does not duplicate the block row');

// --- distinct height still records normally ---
bridge.recordBlock(18, 'cccc_hash', 'tracerfx123.rig01', REWARD_SAT);
assert.strictEqual(bridge.db.prepare('SELECT COUNT(*) n FROM pool_payouts').get().n, 2,
  'a legitimate new-height block still credits');

bridge.db.close();
try { fs.unlinkSync(dbPath); } catch (e) {}
console.log('portal_bridge.test.js: all assertions passed');
