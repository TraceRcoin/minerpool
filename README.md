# Tracercoin Mining Pool (TFX)

The community **mining pool** for **Tracercoin** — an independent, sovereign Scrypt
Proof-of-Work blockchain. Miners point their Scrypt hardware here to combine hash power,
process blocks together, and share rewards.

> Part of the Tracercoin stack. Chain: `github.com/Tracerfx123/blockchain` · Website:
> https://tracercoin.org

---

## Prerequisites

- **Linux host** (the pool runs headless; Server 2 in production).
- **Node.js 18+ (LTS)** and **npm** — builds the engine and the `better-sqlite3` native
  module via `npm ci`.
- **Python 3** — runs `payout_monitor.py` (block-maturity + on-chain payout loop).
- A **synced Tracercoin full node** (`tracercoind`) on the **consensus build**, reachable over
  **localhost RPC (port 9556)**. Its build/run and peer prerequisites — including adding the
  launch node `addnode=159.65.188.80:9555` so the node actually syncs the live chain — are in
  `github.com/Tracerfx123/blockchain` (README + `doc/build-prerequisites.md`).
- The daemon `rpcpassword` from that node's `tracercoin.conf` (injected by `gen-config.js` at
  runtime — never committed). No Redis or external DB required; state lives in the co-located
  SQLite the pool writes to.

## What it does

- Pools Scrypt hash power to mine **TFX** blocks and distribute rewards to contributors.
- Syncs with the Tracercoin ledger and validates work on each new block.
- Runs on the NOMP-style Scrypt pool model.

## Pool parameters

| Parameter | Value |
|---|---|
| Algorithm | Scrypt |
| Stratum port | 3333 |
| Dev fee | 2% |
| Host | `pool.tracercoin.org` (Server 2) |
| Coin | TFX (`tfx1…` addresses) |

## Connecting a miner

```
stratum+tcp://pool.tracercoin.org:3333
```

Use your own `tfx1…` payout address as the username. Rewards are paid in mined TFX only.

## Notes

- The pool connects to a Tracercoin full node (`tracercoind`, RPC localhost:9556).
- Block reward is 400 TFX, halving every 840,000 blocks; target block time 2.5 minutes.
- This is mining infrastructure. It makes no representation about price, return, yield, or
  profit — miners earn newly minted TFX for the work they contribute.

## Repository layout (portal-integrated pool)

This repo holds the pool-side source that runs at `/opt/tfxpool` on the pool box.
It was verified end-to-end on **staging** (portal-authed rigs → shares/blocks →
on-chain testnet payouts).

| Path | Role |
|---|---|
| `engine/` | node-stratum-pool engine (NOMP-style; `lib/*.js` is the stratum/daemon core) |
| `init.js` | Pool entrypoint — wires the engine to portal-integrated auth + the stats writer |
| `portal_bridge.js` | Authorizes each rig against the miner portal's `/api/portal/worker-auth` (over HTTPS); records `shares` / `blocks` / `payouts` into the LOCAL spool DB |
| `ingest_client.js` | Owns the local spool DB (`SPOOL_DB`, WAL) and the flusher loop — every ~10s it POSTs an absolute stats snapshot, then unsynced blocks + payouts, to the production portal's `/api/portal/ingest/*` (idempotent, retained-until-acked; mining never blocks on the portal) |
| `payout_monitor.py` | Maturity + payout loop — confirms mature blocks, sends credited amounts on-chain, records txids, flips payouts to `paid` — writing ONLY the spool DB (`synced=0`); the flusher syncs them up |
| `gen-config.js` | Generates `pool_config.json` by injecting the daemon `rpcpassword` read from `tracercoin.conf` (never prints it) |
| `pool_config.example.json` | Redacted config template — copy to `pool_config.json` and fill in real address / rpc creds (the real file is git-ignored) |
| `pool.env.example` | Template for `/opt/tfxpool/pool.env` (systemd `EnvironmentFile`, 600, git-ignored): `PORTAL_BASE_URL`, `POOL_INTERNAL_TOKEN`, `POOL_INGEST_TOKEN`, `SPOOL_DB`, mainnet `TFX_CLI` |
| `deploy/*.service` | Example systemd units (`tfxpool.service`, `tfx-payout-monitor.service`) wiring `EnvironmentFile=/opt/tfxpool/pool.env` |
| `run_testminers.sh` | Staging helper — launches cpuminer rigs authed via the portal (passwords read from a creds file, never hardcoded) |
| `package.json` / `package-lock.json` | Pool deps (`better-sqlite3`); run `npm ci` on the box |

### Running the pool

```bash
npm ci                       # install engine + better-sqlite3 (node_modules is git-ignored)
node gen-config.js           # writes pool_config.json with the rpcpassword injected
node init.js                 # start the portal-integrated stratum pool
python3 payout_monitor.py    # start the maturity/payout loop (add --once for a single pass)
```

`pool_config.json` is **never committed** — it carries the live daemon `rpcpassword`.
Start from `pool_config.example.json`.

### Portal sync (cross-box ingest, production-cutover.md §1)

The pool box (`pool-1`) and the portal backend (`empire-web-1`) are separate machines
with separate SQLite files, so the pool never writes the portal DB directly. Instead:

1. `portal_bridge.js` + `payout_monitor.py` write the pool's own **spool DB** (`SPOOL_DB`).
2. `ingest_client.js`'s flusher POSTs **absolute snapshots** (`X-Pool-Token: POOL_INGEST_TOKEN`)
   to the backend's `/api/portal/ingest/{stats,blocks,payouts}`, which is the single writer
   of `waitlist.db`. The portal then renders live per-worker hashrate/shares/blocks/payouts.

All config is env-driven (nothing hardcoded). Copy `pool.env.example` to
`/opt/tfxpool/pool.env` (600, git-ignored) and fill it:

- **`PORTAL_BASE_URL`** — `https://tracercoin.org` (worker-auth + ingest share it).
- **`POOL_INTERNAL_TOKEN`** — the prod worker-auth secret (copied from the backend's env).
- **`POOL_INGEST_TOKEN`** — the ingest secret (the SAME value set in the backend's env;
  separate from the worker-auth token).
- **`SPOOL_DB`** — the local spool path (default `/var/lib/tfxpool/spool.db`).
- **`payout_monitor.py`** — `TFX_CLI` switches to mainnet (drop `-testnet`,
  `-rpcwallet=poolwallet`); set `COINBASE_MATURITY` / `MINIMUM_PAYOUT` as desired.
- **`pool_config.json`** — real pool payout `address`, dev-fee `rewardRecipients`, and the
  mainnet daemon RPC port/creds (generated via `gen-config.js`).

## Related repositories

- **Chain / daemon** — `github.com/Tracerfx123/blockchain`
- **Wallet** — `github.com/TraceRcoin/wallet`
- **Exchange (non-custodial)** — `github.com/TraceRcoin/exchange`

## License

Released under the terms of the TFX Token license.
