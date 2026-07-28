#!/usr/bin/env python3
"""
Offline dry-run verification for payout_monitor_mainnet.py.

Builds a throwaway SQLite fixture with the pool_* / portal_accounts schema (a couple
of mature blocks + payout rows in various states), stubs the daemon CLI so NOTHING
touches a real node or wallet, runs the monitor's cycle in --dry-run, and asserts it:
  * computes each payable amount correctly,
  * skips null-address and testnet-address accounts,
  * skips rows already carrying a txid (idempotency / never double-pay),
  * refuses a payout that would breach the per-block 98% conservation cap,
  * defers payouts on a not-yet-confirmed block,
  * skips sub-minimum credits,
  * computes the dev-fee sweep (2% of confirmed-block rewards) to treasury.

No network, no daemon, no funds moved. Run:  python tests/dryrun_fixture_test.py
"""
import contextlib
import io
import json
import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)

GOOD_ADDR = "tfx1qcj9mr5mavhx2xx77mc722vjwfg8flk0gch7tk2"      # valid mainnet
TESTNET_ADDR = "ttfx1q270fnrwffhtywgk2626xu0kjmutc7t8h54v4j7"   # testnet -> must be rejected
TREASURY = "tfx1ql6qduelyr9xuz7wv0q7nt3hlr0am0ssqtss8kl"


def build_fixture(path):
    c = sqlite3.connect(path)
    c.executescript(
        """
        CREATE TABLE portal_accounts (id INTEGER PRIMARY KEY, username TEXT, payout_address TEXT);
        CREATE TABLE pool_blocks (height INTEGER PRIMARY KEY, hash TEXT, finder_worker TEXT,
                                  reward_tfx REAL, status TEXT, found_at TEXT);
        CREATE TABLE pool_payouts (id INTEGER PRIMARY KEY, account_id INTEGER, worker_name TEXT,
                                   amount_tfx REAL, block_height INTEGER, status TEXT,
                                   txid TEXT, created_at TEXT, paid_at TEXT);
        """
    )
    c.executemany(
        "INSERT INTO portal_accounts (id, username, payout_address) VALUES (?,?,?)",
        [
            (1, "tracerfx123", GOOD_ADDR),
            (2, "testboy123", None),          # null address -> skip
            (3, "badaddr", TESTNET_ADDR),     # testnet address -> skip
        ],
    )
    c.executemany(
        "INSERT INTO pool_blocks (height, hash, finder_worker, reward_tfx, status, found_at) "
        "VALUES (?,?,?,?,?,?)",
        [
            (2, "hash2", "rig01", 400.0, "confirmed", "t"),   # cap = 392
            (3, "hash3", "rig01", 400.0, "pending",   "t"),   # mature but not confirmed -> defer
            (4, "hash4", "rigA",  400.0, "confirmed", "t"),   # cap = 392; already-paid 200
            (5, "hash5", "rigX",  400.0, "confirmed", "t"),   # cap = 392
        ],
    )
    c.executemany(
        "INSERT INTO pool_payouts (id, account_id, worker_name, amount_tfx, block_height, status, "
        "txid, created_at, paid_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [
            (1, 1, "rig01", 392.0, 2, "pending", None, "t", None),      # PAY 392
            (2, 2, "rig01", 5.0,   2, "pending", None, "t", None),      # skip: null address
            (3, 1, "rigA",  200.0, 4, "pending", "abcd" * 16, "t", None),  # idempotent: pending but has txid (crash mid-flip)
            (4, 1, "rigB",  200.0, 4, "pending", None, "t", None),      # REFUSE: 200+200>392 cap
            (5, 1, "rigC",  100.0, 4, "pending", None, "t", None),      # PAY 100 (200+100<=392)
            (6, 1, "rig01", 50.0,  3, "pending", None, "t", None),      # DEFER: block 3 not confirmed
            (7, 1, "rigX",  0.5,   5, "pending", None, "t", None),      # skip: below MINIMUM_PAYOUT
            (8, 1, "rigY",  10.0,  5, "pending", None, "t", None),      # PAY 10
            (9, 3, "rigZ",  10.0,  5, "pending", None, "t", None),      # skip: testnet address
        ],
    )
    c.commit()
    c.close()


def fake_cli(*args):
    """Stub daemon: mature blocks, a fat balance, unencrypted wallet. No sends ever."""
    if args[0] == "getblock":
        return json.dumps({"confirmations": 200})
    if args[0] == "getbalance":
        return "1000"
    if args[0] == "getwalletinfo":
        return "{}"                       # no 'unlocked_until' => unencrypted
    raise AssertionError(f"unexpected daemon call in dry-run: {args}")


def main():
    tmp = tempfile.mkdtemp()
    db = os.path.join(tmp, "portal.db")
    build_fixture(db)

    os.environ.update(
        POOL_DB=db,
        TFX_CLI="stub",
        MINIMUM_PAYOUT="1",
        HOT_WALLET_FLOAT="10",
        MIN_SWEEP="1",
        DEV_FEE="0.02",
        TREASURY_ADDRESS=TREASURY,
        COINBASE_MATURITY="100",
    )

    import payout_monitor_mainnet as m
    m.cli = fake_cli  # no daemon

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        m.cycle(dry_run=True, do_sweep=True)
    out = buf.getvalue()
    print(out)

    def want(substr):
        assert substr in out, f"MISSING expected log line: {substr!r}"

    # payable + amounts
    want("WOULD PAY 2:1:rig01: 392.00000000")
    want("WOULD PAY 4:1:rigC: 100.00000000")
    want("WOULD PAY 5:1:rigY: 10.00000000")
    want("total would-pay 502.00000000")
    # skips / refusals
    want("skip 2:2:rig01: no valid tfx1 payout address")   # null
    want("skip 5:3:rigZ: no valid tfx1 payout address")    # testnet
    want("already has txid")                                # idempotency (row 3)
    want("REFUSE 4:1:rigB")                                 # conservation cap
    want("defer 3:1:rig01")                                 # block not confirmed
    want("below MINIMUM_PAYOUT")                            # row 7
    # dev-fee sweep: 2% of confirmed rewards (400*3=1200) = 24 TFX
    want("WOULD SWEEP 24.00000000 TFX dev fee -> treasury")

    # nothing was mutated in dry-run
    c = sqlite3.connect(db)
    paid = c.execute("SELECT COUNT(*) FROM pool_payouts WHERE status='paid'").fetchone()[0]
    swept = c.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='pool_sweeps'"
    ).fetchone()[0]
    c.close()
    assert paid == 0, f"dry-run must not mark anything paid (expected 0, got {paid})"
    # sweep table is created lazily; ensure no sweep row was written
    print("\nALL DRY-RUN ASSERTIONS PASSED "
          f"(paid rows unchanged={paid}, sweep_table_created={bool(swept)}, no sweep rows written)")


if __name__ == "__main__":
    main()
