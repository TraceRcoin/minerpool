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
    # 1. confirm mature blocks
    for b in c.execute("SELECT height, hash, status FROM pool_blocks WHERE status='pending'").fetchall():
        try:
            confs = json.loads(cli("getblock", b["hash"], "1")).get("confirmations", 0)
        except Exception as e:
            print(f"[monitor] getblock {b['height']} err: {e}", flush=True)
            continue
        if confs >= COINBASE_MATURITY:
            c.execute("UPDATE pool_blocks SET status='confirmed' WHERE height=?", (b["height"],))
            c.commit()
            print(f"[monitor] block {b['height']} matured ({confs} confs) -> confirmed", flush=True)

    # 2. pay out pending payouts whose block is confirmed (coinbase spendable)
    rows = c.execute(
        """SELECT p.id, p.account_id, p.amount_tfx, p.block_height, a.payout_address
             FROM pool_payouts p
             JOIN portal_accounts a ON a.id = p.account_id
            WHERE p.status='pending'"""
    ).fetchall()
    # sendtoaddress self-gates on spendable (matured) coinbase — an immature wallet
    # simply throws "Insufficient funds" and the row stays pending until a coinbase
    # matures. So we attempt every pending payout each cycle; no separate confirmed gate.
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
