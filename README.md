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

## Related repositories

- **Chain / daemon** — `github.com/Tracerfx123/blockchain`
- **Wallet** — `github.com/TraceRcoin/wallet`
- **Exchange (non-custodial)** — `github.com/TraceRcoin/exchange`

## License

Released under the terms of the MIT license.
