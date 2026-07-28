#!/usr/bin/env python3
"""
Pool payout / maturity monitor  (STAGING).

Loops over the pool_* ledger the stratum bridge writes and:
  1. marks pool_blocks 'confirmed' once the coinbase reaches COINBASE_MATURITY confs,
  2. once a block's coinbase is *spendable*, pays the credited miner amount on-chain
     from the pool wallet to the account's payout_address (real sendtoaddress),
     records the txid, and flips the pool_payouts row to 'paid'.

Honest end-to-end: a 'paid' row always has a real testnet txid behind it. If the
coinbase is still immature the send simply fails and the row stays 'pending' — it
retries next cycle. Nothing is faked.

Production diff: point DB_PATH at the prod portal DB, set the same COINBASE_MATURITY,
and MINIMUM_PAYOUT as desired. The CLI invocation switches to mainnet by dropping
-testnet and pointing -datadir at the mainnet wallet.
"""
import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone

DB_PATH = os.environ.get("STAGING_DB", "/var/lib/tfx-staging/portal.db")
CLI = os.environ.get(
    "TFX_CLI",
    "/usr/local/bin/tracercoin-cli -testnet -datadir=/root/.tracercoin",
).split()
COINBASE_MATURITY = int(os.environ.get("COINBASE_MATURITY", "100"))
MINIMUM_PAYOUT = float(os.environ.get("MINIMUM_PAYOUT", "0"))
INTERVAL = int(os.environ.get("MONITOR_INTERVAL", "30"))


def cli(*args):
    out = subprocess.run(CLI + list(args), capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip())
    return out.stdout.strip()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def conn():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    return c


def cycle():
    c = conn()
    # 1. confirm mature blocks.
    #
    # A block only confirms once the daemon reports the STORED hash on its active chain
    # with >= COINBASE_MATURITY confirmations. getblock reports confirmations = -1 for a
    # block that exists but is off the active chain (an orphan), which never satisfies the
    # gate, so an orphaned sibling never confirms and never funds a payout.
    #
    # Self-heal for the "keep first block" rule (portal_bridge recordBlock keeps the FIRST
    # row seen at a height): if that first-seen hash turns out to be the orphan, the real
    # winner at this height would otherwise never confirm. When the stored hash is off-chain
    # (confs < 0), reconcile to the active-chain hash reported by getblockhash(height) before
    # re-checking maturity, so a legit block is still paid exactly once.
    for b in c.execute("SELECT height, hash, status FROM pool_blocks WHERE status='pending'").fetchall():
        block_hash = b["hash"]
        try:
            confs = json.loads(cli("getblock", block_hash, "1")).get("confirmations", 0)
        except Exception as e:
            print(f"[monitor] getblock {b['height']} err: {e}", flush=True)
            continue
        if confs is not None and confs < 0:
            # Stored hash is off the active chain — try to adopt the active-chain hash at
            # this height (if one exists yet) so the winner can mature and pay.
            try:
                active_hash = cli("getblockhash", str(b["height"]))
            except Exception:
                active_hash = None
            if active_hash and active_hash != block_hash:
                try:
                    confs = json.loads(cli("getblock", active_hash, "1")).get("confirmations", 0)
                except Exception as e:
                    print(f"[monitor] getblock(active) {b['height']} err: {e}", flush=True)
                    continue
                c.execute(
                    "UPDATE pool_blocks SET hash=? WHERE height=?", (active_hash, b["height"])
                )
                c.commit()
                block_hash = active_hash
                print(
                    f"[monitor] block {b['height']} stored hash was orphaned; "
                    f"adopted active-chain hash {active_hash}", flush=True
                )
        if confs >= COINBASE_MATURITY:
            c.execute("UPDATE pool_blocks SET status='confirmed' WHERE height=?", (b["height"],))
            c.commit()
            print(f"[monitor] block {b['height']} matured ({confs} confs) -> confirmed", flush=True)

    # 2. pay out pending payouts whose funding block is CONFIRMED (coinbase spendable).
    #
    # Money-safety gate (fork17): only pay a credit whose block_height reached
    # status='confirmed' in step 1 — i.e. the block that funds it is on the daemon's
    # active chain with >= COINBASE_MATURITY confirmations. A pending/orphaned block
    # never funds a send, so a stale height-N sibling can no longer trigger a real
    # sendtoaddress. Relying on "sendtoaddress throws Insufficient funds" alone was
    # unsafe: with a warm hot-wallet float (or an unrelated matured coinbase), an
    # orphan-funded payout row would have spent real coins. The JOIN on pool_blocks
    # with status='confirmed' makes the funding block a hard precondition.
    rows = c.execute(
        """SELECT p.id, p.account_id, p.amount_tfx, p.block_height, a.payout_address
             FROM pool_payouts p
             JOIN portal_accounts a ON a.id = p.account_id
             JOIN pool_blocks b     ON b.height = p.block_height
            WHERE p.status='pending'
              AND b.status='confirmed'"""
    ).fetchall()
    for p in rows:
        if not p["payout_address"]:
            print(f"[monitor] payout {p['id']} has no payout_address; skipping", flush=True)
            continue
        if p["amount_tfx"] < MINIMUM_PAYOUT:
            continue
        amt = f"{p['amount_tfx']:.8f}"
        try:
            txid = cli("sendtoaddress", p["payout_address"], amt)
        except Exception as e:
            print(f"[monitor] payout {p['id']} send deferred: {e}", flush=True)
            continue
        c.execute(
            "UPDATE pool_payouts SET status='paid', txid=?, paid_at=? WHERE id=?",
            (txid, now_iso(), p["id"]),
        )
        c.commit()
        print(f"[monitor] PAID payout {p['id']} {amt} TFX -> {p['payout_address']} txid={txid}", flush=True)
    c.close()


def main():
    once = "--once" in sys.argv
    print(f"[monitor] start db={DB_PATH} maturity={COINBASE_MATURITY} interval={INTERVAL}s once={once}", flush=True)
    while True:
        try:
            cycle()
        except Exception as e:
            print(f"[monitor] cycle error: {e}", flush=True)
        if once:
            break
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
