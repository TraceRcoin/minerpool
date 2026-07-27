# Tracercoin Mining Pool (TFX)

The community **mining pool** for **Tracercoin** — an independent, sovereign Scrypt
Proof-of-Work blockchain. Miners point their Scrypt hardware here to combine hash power,
process blocks together, and share rewards.

> Part of the Tracercoin stack. Chain: `github.com/Tracerfx123/blockchain` · Website:
> https://tracercoin.org

---

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
| `portal_bridge.js` | Authorizes each rig against the miner portal's `/api/portal/worker-auth`; writes `pool_worker_stats` / `pool_blocks` / `pool_payouts` / `pool_round` into the co-located portal SQLite |
| `payout_monitor.py` | Maturity + payout loop — confirms mature blocks, sends credited amounts on-chain, records txids, flips payouts to `paid` |
| `gen-config.js` | Generates `pool_config.json` by injecting the daemon `rpcpassword` read from `tracercoin.conf` (never prints it) |
| `pool_config.example.json` | Redacted config template — copy to `pool_config.json` and fill in real address / rpc creds (the real file is git-ignored) |
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

### Staging → production cutover diff

The committed source is the **staging** build. Nothing hardcodes a secret; the cutover
is entirely config/environment:

- **`portal_bridge.js`** — set env `PORTAL_HOST` / `PORTAL_PORT` to the production portal,
  `STAGING_DB` to the production portal DB path, and supply the prod `POOL_INTERNAL_TOKEN`
  via the environment (never in the file).
- **`payout_monitor.py`** — point `STAGING_DB` at the prod portal DB; switch `TFX_CLI` from
  the `-testnet` invocation to mainnet (drop `-testnet`, point `-datadir` at the mainnet
  wallet); set `COINBASE_MATURITY` / `MINIMUM_PAYOUT` as desired.
- **`pool_config.json`** — real pool payout `address`, dev-fee `rewardRecipients`, and the
  mainnet daemon RPC port/creds (generated via `gen-config.js`).

## Related repositories

- **Chain / daemon** — `github.com/Tracerfx123/blockchain`
- **Wallet** — `github.com/TraceRcoin/wallet`
- **Exchange (non-custodial)** — `github.com/TraceRcoin/exchange`

## License

Released under the terms of the TFX Token license.
