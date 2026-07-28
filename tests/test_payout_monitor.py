#!/usr/bin/env python3
"""Fixture test for payout_monitor.cycle() money-safety gate + orphan self-heal.

Run: python tests/test_payout_monitor.py

We build a throwaway SQLite with the portal pool_* schema and a stub `cli()` that
emulates the daemon: a mapping of block_hash -> confirmations, and a mapping of
height -> active-chain hash for getblockhash. No real tracercoind is touched.

Asserts:
  1. A pending payout whose funding block is still 'pending' is NOT paid.
  2. Once step 1 confirms the block, the payout is paid exactly once (real send).
  3. An orphaned stored hash self-heals: the monitor adopts the active-chain hash at
     that height, confirms it, and pays once — no double pay for the sibling.
"""
import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

DB_FD, DB_PATH = tempfile.mkstemp(suffix="_pmon.db")
os.close(DB_FD)
os.environ["STAGING_DB"] = DB_PATH
os.environ["COINBASE_MATURITY"] = "100"
os.environ["MINIMUM_PAYOUT"] = "0"

import payout_monitor as pm  # noqa: E402

# --- daemon stub -----------------------------------------------------------------
CONF_BY_HASH = {}      # block_hash -> confirmations (int; -1 == off active chain)
ACTIVE_BY_HEIGHT = {}  # str(height) -> active-chain block hash
SENDS = []             # captured sendtoaddress calls


def fake_cli(*args):
    cmd = args[0]
    if cmd == "getblock":
        h = args[1]
        if h not in CONF_BY_HASH:
            raise RuntimeError("Block not found")
        return '{"confirmations": %d}' % CONF_BY_HASH[h]
    if cmd == "getblockhash":
        height = args[1]
        if height not in ACTIVE_BY_HEIGHT:
            raise RuntimeError("Block height out of range")
        return ACTIVE_BY_HEIGHT[height]
    if cmd == "sendtoaddress":
        SENDS.append((args[1], args[2]))
        return "txid_%d" % len(SENDS)
    raise RuntimeError("unexpected cli " + cmd)


pm.cli = fake_cli


def fresh_db():
    c = sqlite3.connect(DB_PATH)
    c.executescript(
        """
        DROP TABLE IF EXISTS pool_blocks;
        DROP TABLE IF EXISTS pool_payouts;
        DROP TABLE IF EXISTS portal_accounts;
        CREATE TABLE pool_blocks (
          height INTEGER PRIMARY KEY, hash TEXT, finder_worker TEXT,
          reward_tfx REAL, status TEXT, found_at TEXT);
        CREATE TABLE pool_payouts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, worker_name TEXT,
          amount_tfx REAL, block_height INTEGER, status TEXT, created_at TEXT,
          txid TEXT, paid_at TEXT, pool_ref TEXT);
        CREATE TABLE portal_accounts (id INTEGER PRIMARY KEY, payout_address TEXT);
        INSERT INTO portal_accounts (id, payout_address) VALUES (7, 'tfx1qminer');
        """
    )
    c.commit()
    c.close()


def status_of_payout(pid):
    c = sqlite3.connect(DB_PATH)
    row = c.execute("SELECT status, txid FROM pool_payouts WHERE id=?", (pid,)).fetchone()
    c.close()
    return row


def stored_block_hash(height):
    c = sqlite3.connect(DB_PATH)
    row = c.execute("SELECT hash, status FROM pool_blocks WHERE height=?", (height,)).fetchone()
    c.close()
    return row


# === Test 1: pending block does not pay ==========================================
fresh_db()
SENDS.clear()
CONF_BY_HASH.clear(); ACTIVE_BY_HEIGHT.clear()
c = sqlite3.connect(DB_PATH)
c.execute("INSERT INTO pool_blocks (height,hash,finder_worker,reward_tfx,status,found_at) "
          "VALUES (17,'winner','rig01',400,'pending','t0')")
c.execute("INSERT INTO pool_payouts (account_id,worker_name,amount_tfx,block_height,status,created_at,pool_ref) "
          "VALUES (7,'rig01',392,17,'pending','t0','17:7:rig01')")
c.commit(); c.close()
CONF_BY_HASH["winner"] = 5   # immature, not yet 100 confs
pm.cycle()
assert SENDS == [], "must NOT send while funding block is pending/immature"
assert status_of_payout(1)[0] == "pending", "payout stays pending"
print("test1 (pending block -> no pay): OK")

# === Test 2: confirmed block pays exactly once ===================================
CONF_BY_HASH["winner"] = 120  # now mature
pm.cycle()
assert stored_block_hash(17)[1] == "confirmed", "block should confirm at >=100 confs"
assert len(SENDS) == 1, "exactly one send after confirmation, got %d" % len(SENDS)
assert SENDS[0] == ("tfx1qminer", "392.00000000"), SENDS
assert status_of_payout(1)[0] == "paid", "payout flips to paid"
pm.cycle()  # idempotency: already paid -> no second send
assert len(SENDS) == 1, "paid payout is not re-sent"
print("test2 (confirmed block -> pay once): OK")

# === Test 3: orphaned stored hash self-heals to active-chain hash ================
fresh_db()
SENDS.clear()
CONF_BY_HASH.clear(); ACTIVE_BY_HEIGHT.clear()
c = sqlite3.connect(DB_PATH)
# The bridge kept the FIRST-seen hash at height 17, which turned out to be the orphan.
c.execute("INSERT INTO pool_blocks (height,hash,finder_worker,reward_tfx,status,found_at) "
          "VALUES (17,'orphan','rig01',400,'pending','t0')")
c.execute("INSERT INTO pool_payouts (account_id,worker_name,amount_tfx,block_height,status,created_at,pool_ref) "
          "VALUES (7,'rig01',392,17,'pending','t0','17:7:rig01')")
c.commit(); c.close()
CONF_BY_HASH["orphan"] = -1     # off the active chain
CONF_BY_HASH["realwinner"] = 130
ACTIVE_BY_HEIGHT["17"] = "realwinner"
pm.cycle()
assert stored_block_hash(17)[0] == "realwinner", "monitor adopts active-chain hash"
assert stored_block_hash(17)[1] == "confirmed", "adopted block confirms"
assert len(SENDS) == 1, "orphan self-heal pays exactly once, got %d" % len(SENDS)
print("test3 (orphan self-heal -> pay once): OK")

# === Test 4: orphan with no active block yet -> never pays =======================
fresh_db()
SENDS.clear()
CONF_BY_HASH.clear(); ACTIVE_BY_HEIGHT.clear()
c = sqlite3.connect(DB_PATH)
c.execute("INSERT INTO pool_blocks (height,hash,finder_worker,reward_tfx,status,found_at) "
          "VALUES (17,'orphan','rig01',400,'pending','t0')")
c.execute("INSERT INTO pool_payouts (account_id,worker_name,amount_tfx,block_height,status,created_at,pool_ref) "
          "VALUES (7,'rig01',392,17,'pending','t0','17:7:rig01')")
c.commit(); c.close()
CONF_BY_HASH["orphan"] = -1     # off chain, and no active hash known at this height
pm.cycle()
assert SENDS == [], "orphan with no active-chain block must never pay"
assert stored_block_hash(17)[1] == "pending", "stays pending"
print("test4 (orphan, no active block -> never pay): OK")

os.remove(DB_PATH)
print("test_payout_monitor.py: all assertions passed")
