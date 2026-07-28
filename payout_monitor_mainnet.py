#!/usr/bin/env python3
"""
Pool payout / maturity monitor  (MAINNET).

This process MOVES REAL FUNDS. It sends on-chain TFX from the pool hot wallet
(`poolwallet` on the mainnet daemon) to each miner's portal payout address, sweeps
the accumulated 2% dev fee to the treasury, and keeps a ledger in the pool DB.

It is the mainnet sibling of the staging `payout_monitor.py`. The only differences
are config (mainnet daemon / wallet / DB) and the money-safety layer that mainnet
requires:

  * --dry-run   compute + log every payout and sweep WITHOUT sending anything.
                This is how you validate before going live. Nothing hits the daemon
                wallet in dry-run; the ledger is not mutated.
  * idempotency a payout row that already carries a txid / status='paid' is never
                re-sent. Rows are identified by a deterministic pool_ref
                (`<height>:<account_id>:<worker>`) so a replay is the same row.
  * conservation for each block, the total paid out (already-paid + this batch) can
                never exceed 98% of that block's reward (100% minus the 2% dev fee).
                Anything that would breach the cap is refused and logged.
  * address     only accounts with a valid mainnet `tfx1…` bech32 payout address are
                paid; null / testnet / malformed addresses are skipped with a warning
                (those miners self-serve an address via the portal).
  * wallet      if `poolwallet` is encrypted, it is unlocked with POOL_WALLET_PASSPHRASE
                for a short window immediately around the sends, then re-locked. The
                passphrase is read from the environment and is NEVER logged. An
                unencrypted wallet is handled gracefully (no unlock attempted).
  * dev-fee     `--sweep` (or the periodic loop) sweeps the accrued 2% dev-fee portion
                to the treasury address, keeping only a working float in the hot wallet.

Config is entirely env-driven so staging vs mainnet is pure configuration. See
`pool.env.example`. Secrets (the wallet passphrase) come from an EnvironmentFile, not
the command line.

Usage:
  python3 payout_monitor_mainnet.py --dry-run --once     # validate, no sends
  python3 payout_monitor_mainnet.py --once               # one real payout pass
  python3 payout_monitor_mainnet.py --sweep --dry-run     # preview a dev-fee sweep
  python3 payout_monitor_mainnet.py --sweep               # real dev-fee sweep
  python3 payout_monitor_mainnet.py                       # daemon loop (payouts + sweep)
"""
import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone

# --------------------------------------------------------------------------- config
POOL_DB = os.environ.get("POOL_DB", "/var/lib/tfxpool-main/portal.db")

# Mainnet CLI: mainnet daemon (RPC 9556), pool wallet, NO -testnet.
CLI = os.environ.get(
    "TFX_CLI",
    "/root/mainbin/tracercoin-cli -datadir=/root/.tracercoin-main -rpcwallet=poolwallet",
).split()

COINBASE_MATURITY = int(os.environ.get("COINBASE_MATURITY", "100"))
MINIMUM_PAYOUT = float(os.environ.get("MINIMUM_PAYOUT", "1"))     # TFX; skip dust credits
PAYOUT_INTERVAL = int(os.environ.get("PAYOUT_INTERVAL", "300"))   # seconds between passes
SWEEP_EVERY = int(os.environ.get("SWEEP_EVERY", "12"))            # sweep once per N passes (0 = never in loop)

DEV_FEE = float(os.environ.get("DEV_FEE", "0.02"))               # 2% dev fee
CONSERVATION_RATIO = 1.0 - DEV_FEE                                 # miners get <= 98% of a block

TREASURY_ADDRESS = os.environ.get(
    "TREASURY_ADDRESS", "tfx1ql6qduelyr9xuz7wv0q7nt3hlr0am0ssqtss8kl"
)
HOT_WALLET_FLOAT = float(os.environ.get("HOT_WALLET_FLOAT", "10"))   # TFX kept in the hot wallet
MIN_SWEEP = float(os.environ.get("MIN_SWEEP", "1"))                  # don't sweep dust

# Wallet passphrase: read from env (EnvironmentFile) only. NEVER logged.
WALLET_PASSPHRASE = os.environ.get("POOL_WALLET_PASSPHRASE", "")
WALLET_UNLOCK_SECONDS = int(os.environ.get("WALLET_UNLOCK_SECONDS", "60"))

# bech32 mainnet address: HRP 'tfx', bech32 charset, reject testnet 'ttfx1…'.
ADDR_RE = re.compile(r"^tfx1[02-9ac-hj-np-z]{6,87}$")

SAT = 100_000_000  # satoshis per TFX


# --------------------------------------------------------------------------- helpers
def log(msg):
    print(f"{now_iso()} [payout-main] {msg}", flush=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def to_sat(tfx):
    """TFX float -> integer satoshis (exact comparisons live in satoshi space)."""
    return int(round(float(tfx) * SAT))


def fmt(tfx):
    return f"{float(tfx):.8f}"


def cli(*args):
    """Invoke tracercoin-cli. Raises RuntimeError on a non-zero exit."""
    out = subprocess.run(CLI + list(args), capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip())
    return out.stdout.strip()


def conn():
    c = sqlite3.connect(POOL_DB, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=5000")
    return c


def pool_ref(height, account_id, worker):
    """Deterministic idempotency key: <height>:<account_id>:<worker>."""
    return f"{height}:{account_id}:{worker or ''}"


def valid_address(addr):
    return bool(addr) and bool(ADDR_RE.match(addr))


# --------------------------------------------------------------- wallet lock/unlock
def wallet_is_encrypted():
    """True if the wallet reports a lock state (has 'unlocked_until')."""
    try:
        info = json.loads(cli("getwalletinfo"))
    except Exception as e:
        log(f"getwalletinfo failed ({e}); assuming unencrypted / handling gracefully")
        return False
    return "unlocked_until" in info


def unlock_wallet(seconds):
    """Unlock the encrypted wallet for `seconds`. Returns True if unlock happened.

    Never logs the passphrase. If the wallet is unencrypted, returns False and the
    caller proceeds without an unlock. If it is encrypted but no passphrase was
    supplied, raises so the batch aborts before any send is attempted.
    """
    if not wallet_is_encrypted():
        log("wallet is not encrypted; skipping unlock")
        return False
    if not WALLET_PASSPHRASE:
        raise RuntimeError(
            "wallet is encrypted but POOL_WALLET_PASSPHRASE is not set — refusing to send"
        )
    cli("walletpassphrase", WALLET_PASSPHRASE, str(seconds))
    log(f"wallet unlocked for {seconds}s")
    return True


def lock_wallet():
    try:
        cli("walletlock")
        log("wallet re-locked")
    except Exception as e:
        log(f"walletlock failed: {e}")


# --------------------------------------------------------------------- maturity pass
def confirm_mature_blocks(c, dry_run):
    """Flip pool_blocks pending -> confirmed once the coinbase reaches maturity."""
    rows = c.execute(
        "SELECT height, hash, status FROM pool_blocks WHERE status='pending'"
    ).fetchall()
    for b in rows:
        try:
            confs = json.loads(cli("getblock", b["hash"], "1")).get("confirmations", 0)
        except Exception as e:
            log(f"getblock {b['height']} err: {e}")
            continue
        if confs >= COINBASE_MATURITY:
            if dry_run:
                log(f"[dry-run] block {b['height']} mature ({confs} confs) -> would confirm")
            else:
                c.execute(
                    "UPDATE pool_blocks SET status='confirmed' WHERE height=?", (b["height"],)
                )
                c.commit()
                log(f"block {b['height']} matured ({confs} confs) -> confirmed")


# --------------------------------------------------------------------- conservation
def already_paid_sat(c, height):
    """Satoshis already marked paid for a block (rows with a txid / status='paid')."""
    row = c.execute(
        """SELECT COALESCE(SUM(amount_tfx),0) AS s
             FROM pool_payouts
            WHERE block_height=? AND (status='paid' OR txid IS NOT NULL)""",
        (height,),
    ).fetchone()
    return to_sat(row["s"] or 0)


def block_cap_sat(c, height):
    """98% of the block reward, in satoshis. None if the block/reward is unknown."""
    row = c.execute(
        "SELECT reward_tfx, status FROM pool_blocks WHERE height=?", (height,)
    ).fetchone()
    if not row or row["reward_tfx"] is None:
        return None, None
    return to_sat(float(row["reward_tfx"]) * CONSERVATION_RATIO), row["status"]


# --------------------------------------------------------------------- payout pass
def process_payouts(c, dry_run):
    """Pay pending payouts whose block is confirmed, address valid, threshold met,
    within the per-block 98% conservation cap. Idempotent + never double-pays."""
    rows = c.execute(
        """SELECT p.id, p.account_id, p.worker_name, p.amount_tfx, p.block_height,
                  p.status, p.txid, a.payout_address
             FROM pool_payouts p
             JOIN portal_accounts a ON a.id = p.account_id
            WHERE p.status='pending'
            ORDER BY p.block_height, p.id"""
    ).fetchall()

    # running total (satoshis) queued/paid per block within THIS batch, seeded with
    # what is already paid on-chain so the cap holds across passes.
    batch_sat = {}
    payable = []  # (row, amount_sat) that pass every gate

    for p in rows:
        ref = pool_ref(p["block_height"], p["account_id"], p["worker_name"])
        # 1. idempotency: already has a txid -> settled, never re-send
        if p["txid"]:
            log(f"skip {ref}: already has txid {p['txid']}")
            continue
        # 2. address gate
        if not valid_address(p["payout_address"]):
            log(f"skip {ref}: no valid tfx1 payout address (got {p['payout_address']!r}) "
                f"— miner must self-serve an address in the portal")
            continue
        # 3. block must exist + be confirmed (coinbase spendable)
        cap_sat, block_status = block_cap_sat(c, p["block_height"])
        if cap_sat is None:
            log(f"skip {ref}: block {p['block_height']} unknown / no reward recorded")
            continue
        if block_status != "confirmed":
            log(f"defer {ref}: block {p['block_height']} not yet confirmed (status={block_status})")
            continue
        # 4. minimum threshold
        amt_sat = to_sat(p["amount_tfx"])
        if amt_sat < to_sat(MINIMUM_PAYOUT):
            log(f"skip {ref}: {fmt(p['amount_tfx'])} TFX below MINIMUM_PAYOUT {fmt(MINIMUM_PAYOUT)}")
            continue
        # 5. per-block conservation cap (<= 98% of reward, incl. already-paid)
        if p["block_height"] not in batch_sat:
            batch_sat[p["block_height"]] = already_paid_sat(c, p["block_height"])
        if batch_sat[p["block_height"]] + amt_sat > cap_sat:
            log(f"REFUSE {ref}: {fmt(p['amount_tfx'])} TFX would breach block "
                f"{p['block_height']} cap (cap={fmt(cap_sat/SAT)} TFX, "
                f"already queued/paid={fmt(batch_sat[p['block_height']]/SAT)} TFX)")
            continue
        batch_sat[p["block_height"]] += amt_sat
        payable.append((p, amt_sat))

    if not payable:
        log("no payable payouts this pass")
        return

    total_sat = sum(a for _, a in payable)
    log(f"{len(payable)} payout(s) selected, total {fmt(total_sat/SAT)} TFX")

    if dry_run:
        for p, amt_sat in payable:
            ref = pool_ref(p["block_height"], p["account_id"], p["worker_name"])
            log(f"[dry-run] WOULD PAY {ref}: {fmt(amt_sat/SAT)} TFX -> {p['payout_address']} "
                f"(block {p['block_height']})")
        log(f"[dry-run] total would-pay {fmt(total_sat/SAT)} TFX (no send, ledger untouched)")
        return

    # ---- real sends: unlock once, send each, re-lock in finally ----
    unlocked = False
    try:
        unlocked = unlock_wallet(WALLET_UNLOCK_SECONDS)
        for p, amt_sat in payable:
            ref = pool_ref(p["block_height"], p["account_id"], p["worker_name"])
            amt = fmt(amt_sat / SAT)
            try:
                txid = cli("sendtoaddress", p["payout_address"], amt)
            except Exception as e:
                log(f"payout {ref} send deferred: {e}")
                continue
            c.execute(
                "UPDATE pool_payouts SET status='paid', txid=?, paid_at=? WHERE id=?",
                (txid, now_iso(), p["id"]),
            )
            c.commit()
            log(f"PAID {ref} {amt} TFX -> {p['payout_address']} txid={txid}")
    finally:
        if unlocked:
            lock_wallet()


# --------------------------------------------------------------------- dev-fee sweep
def ensure_sweep_table(c):
    c.execute(
        """CREATE TABLE IF NOT EXISTS pool_sweeps (
               id          INTEGER PRIMARY KEY AUTOINCREMENT,
               amount_tfx  REAL NOT NULL,
               address     TEXT NOT NULL,
               txid        TEXT,
               swept_at    TEXT NOT NULL
           )"""
    )
    c.commit()


def swept_total_sat(c):
    try:
        row = c.execute("SELECT COALESCE(SUM(amount_tfx),0) AS s FROM pool_sweeps").fetchone()
    except sqlite3.OperationalError:
        return 0  # table not created yet (e.g. first run / dry-run)
    return to_sat(row["s"] or 0)


def accrued_devfee_sat(c):
    """2% of the reward over every confirmed block = the dev fee the pool has earned."""
    row = c.execute(
        "SELECT COALESCE(SUM(reward_tfx),0) AS s FROM pool_blocks WHERE status='confirmed'"
    ).fetchone()
    return to_sat((row["s"] or 0) * DEV_FEE)


def spendable_sat():
    """Hot-wallet spendable balance in satoshis (best effort; 0 on daemon error)."""
    try:
        bal = float(cli("getbalance"))
        return to_sat(bal)
    except Exception as e:
        log(f"getbalance failed: {e}")
        return None


def sweep_devfee(c, dry_run):
    """Sweep the accrued (but not-yet-swept) 2% dev fee to treasury, never touching
    the working float. Bounded by both the accrued amount and the spendable balance."""
    if not valid_address(TREASURY_ADDRESS):
        log(f"sweep aborted: TREASURY_ADDRESS {TREASURY_ADDRESS!r} is not a valid tfx1 address")
        return
    if not dry_run:
        ensure_sweep_table(c)  # dry-run mutates nothing, not even a table create

    owed_sat = accrued_devfee_sat(c) - swept_total_sat(c)
    if owed_sat <= 0:
        log(f"sweep: no dev fee owed (accrued={fmt(accrued_devfee_sat(c)/SAT)} TFX, "
            f"already swept={fmt(swept_total_sat(c)/SAT)} TFX)")
        return

    bal_sat = spendable_sat()
    if bal_sat is None:
        if dry_run:
            # offline dry-run: report intent from the ledger alone
            amount_sat = owed_sat
            log(f"[dry-run] balance unavailable; dev fee owed by ledger = {fmt(owed_sat/SAT)} TFX")
        else:
            log("sweep aborted: cannot read hot-wallet balance")
            return
    else:
        available_sat = bal_sat - to_sat(HOT_WALLET_FLOAT)
        amount_sat = min(owed_sat, available_sat)
        if available_sat <= 0:
            log(f"sweep: balance {fmt(bal_sat/SAT)} TFX <= float {fmt(HOT_WALLET_FLOAT)} TFX; nothing to sweep")
            return

    if amount_sat < to_sat(MIN_SWEEP):
        log(f"sweep: {fmt(amount_sat/SAT)} TFX below MIN_SWEEP {fmt(MIN_SWEEP)}; skipping")
        return

    if dry_run:
        log(f"[dry-run] WOULD SWEEP {fmt(amount_sat/SAT)} TFX dev fee -> treasury "
            f"{TREASURY_ADDRESS} (keeping {fmt(HOT_WALLET_FLOAT)} TFX float; no send)")
        return

    unlocked = False
    try:
        unlocked = unlock_wallet(WALLET_UNLOCK_SECONDS)
        txid = cli("sendtoaddress", TREASURY_ADDRESS, fmt(amount_sat / SAT))
        c.execute(
            "INSERT INTO pool_sweeps (amount_tfx, address, txid, swept_at) VALUES (?,?,?,?)",
            (amount_sat / SAT, TREASURY_ADDRESS, txid, now_iso()),
        )
        c.commit()
        log(f"SWEPT {fmt(amount_sat/SAT)} TFX dev fee -> treasury {TREASURY_ADDRESS} txid={txid}")
    except Exception as e:
        log(f"sweep send failed: {e}")
    finally:
        if unlocked:
            lock_wallet()


# --------------------------------------------------------------------------- driver
def cycle(dry_run, do_sweep):
    c = conn()
    try:
        confirm_mature_blocks(c, dry_run)
        process_payouts(c, dry_run)
        if do_sweep:
            sweep_devfee(c, dry_run)
    finally:
        c.close()


def main():
    ap = argparse.ArgumentParser(description="Tracercoin MAINNET pool payout monitor")
    ap.add_argument("--dry-run", action="store_true",
                    help="compute + log payouts/sweeps without sending or mutating the ledger")
    ap.add_argument("--once", action="store_true", help="run a single pass and exit")
    ap.add_argument("--sweep", action="store_true",
                    help="run the dev-fee sweep this pass (also runs the payout pass)")
    ap.add_argument("--sweep-only", action="store_true",
                    help="only run the dev-fee sweep (no payout pass)")
    args = ap.parse_args()

    mode = "DRY-RUN" if args.dry_run else "LIVE"
    log(f"start mode={mode} db={POOL_DB} maturity={COINBASE_MATURITY} "
        f"min_payout={fmt(MINIMUM_PAYOUT)} interval={PAYOUT_INTERVAL}s "
        f"dev_fee={DEV_FEE} treasury={TREASURY_ADDRESS} once={args.once}")

    if args.sweep_only:
        c = conn()
        try:
            sweep_devfee(c, args.dry_run)
        finally:
            c.close()
        return

    passes = 0
    while True:
        passes += 1
        do_sweep = args.sweep or (SWEEP_EVERY > 0 and passes % SWEEP_EVERY == 0)
        try:
            cycle(args.dry_run, do_sweep)
        except Exception as e:
            log(f"cycle error: {e}")
        if args.once:
            break
        time.sleep(PAYOUT_INTERVAL)


if __name__ == "__main__":
    main()
