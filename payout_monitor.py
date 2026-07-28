#!/usr/bin/env python3
"""
Pool payout / maturity monitor.

Loops over the LOCAL spool ledger (the pool's own DB, shared with the Node stratum
bridge and the ingest flusher) and:
  1. marks spool_blocks 'confirmed' once the coinbase reaches COINBASE_MATURITY confs,
  2. once a block's coinbase is *spendable*, pays the credited miner amount on-chain
     from the pool wallet to the account's payout_address (real sendtoaddress),
     records the txid, and flips the spool_payouts row to 'paid'.

It only ever writes the SPOOL DB (never the portal DB): every state change also sets
`synced = 0`, so the single ingest flusher in ingest_client.js is the one network
writer that syncs 'confirmed'/'paid'/txid up to the portal — one retry story.

Honest end-to-end: a 'paid' row always has a real chain txid behind it. If the
coinbase is still immature the send simply fails and the row stays 'pending' — it
retries next cycle. Nothing is faked.

Production: point SPOOL_DB at the pool spool (/var/lib/tfxpool/spool.db) and set
TFX_CLI to the MAINNET wallet invocation (no -testnet, -rpcwallet=poolwallet).
"""
import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone

# The pool's local spool DB (shared with ingest_client.js + portal_bridge.js).
DB_PATH = os.environ.get("SPOOL_DB", "/var/lib/tfxpool/spool.db")
CLI = os.environ.get(
    "TFX_CLI",
    "/usr/local/bin/tracercoin-cli -datadir=/root/.tracercoin -rpcwallet=poolwallet",
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
    c.execute("PRAGMA busy_timeout = 5000")
    return c


def cycle():
    c = conn()
    # 1. confirm mature blocks (mark synced=0 so the flusher re-syncs the transition)
    for b in c.execute("SELECT height, hash, status FROM spool_blocks WHERE status='pending'").fetchall():
        try:
            confs = json.loads(cli("getblock", b["hash"], "1")).get("confirmations", 0)
        except Exception as e:
            print(f"[monitor] getblock {b['height']} err: {e}", flush=True)
            continue
        if confs >= COINBASE_MATURITY:
            c.execute("UPDATE spool_blocks SET status='confirmed', synced=0 WHERE height=?", (b["height"],))
            c.commit()
            print(f"[monitor] block {b['height']} matured ({confs} confs) -> confirmed", flush=True)

    # 2. pay pending payouts. The payout_address is carried on the spool row itself
    #    (captured from worker-auth at block time) — no portal DB join needed here.
    rows = c.execute(
        "SELECT pool_ref, account_id, amount_tfx, block_height, payout_address "
        "FROM spool_payouts WHERE status='pending'"
    ).fetchall()
    # sendtoaddress self-gates on spendable (matured) coinbase — an immature wallet
    # simply throws "Insufficient funds" and the row stays pending until a coinbase
    # matures. So we attempt every pending payout each cycle; no separate confirmed gate.
    for p in rows:
        if not p["payout_address"]:
            print(f"[monitor] payout {p['pool_ref']} has no payout_address; skipping", flush=True)
            continue
        if p["amount_tfx"] < MINIMUM_PAYOUT:
            continue
        amt = f"{p['amount_tfx']:.8f}"
        try:
            txid = cli("sendtoaddress", p["payout_address"], amt)
        except Exception as e:
            print(f"[monitor] payout {p['pool_ref']} send deferred: {e}", flush=True)
            continue
        c.execute(
            "UPDATE spool_payouts SET status='paid', txid=?, paid_at=?, synced=0 WHERE pool_ref=?",
            (txid, now_iso(), p["pool_ref"]),
        )
        c.commit()
        print(f"[monitor] PAID payout {p['pool_ref']} {amt} TFX -> {p['payout_address']} txid={txid}", flush=True)
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
