# Loot Box Commit-Reveal Smart Contract

This directory contains the TEALScript source for the commit-reveal randomness contract used by the loot box system.

## Overview

The contract implements a PCG32 pseudo-random number generator seeded by Algorand's VRF beacon. This gives verifiable, on-chain randomness for prize selection.

## Attribution

The PCG32 pseudo-random number generator used in this contract is based on [lib-pcg-avm](https://github.com/CiottiGiorgio/lib-pcg-avm) by Giorgio Ciotti, an open-source PCG implementation for the Algorand Virtual Machine. The commit-reveal pattern uses the [Algorand Randomness Beacon](https://developer.algorand.org/docs/get-details/randomness-beacon/) for VRF-derived seed entropy.

## Deploying Your Own

You need to deploy your own instance of this contract before enabling live loot box mode.

### Prerequisites

- [AlgoKit](https://developer.algorand.org/docs/get-started/algokit/) installed
- TEALScript compiler (`npm install -g @algorandfoundation/tealscript`)

### Steps

1. Compile the contract:
   ```bash
   npx tealscript contracts/lootbox-commit-reveal/contract.algo.ts contracts/lootbox-commit-reveal/artifacts
   ```

2. Deploy using AlgoKit or `goal`:
   ```bash
   algokit deploy
   ```

3. Set the deployed app ID in your `.env.local`:
   ```
   LOOTBOX_CONTRACT_APP_ID=<your-app-id>
   ```

4. Enable live mode:
   ```
   LOOTBOX_LIVE_ENABLED=true
   ```

### Testing Locally

Use AlgoKit LocalNet to test the contract before deploying to MainNet:

```bash
algokit localnet start
```

Then deploy to LocalNet and run the loot box flow end-to-end.

## Contract State

| Key | Type | Description |
|-----|------|-------------|
| `state` | uint64 | PCG32 internal state |
| `randomness` | bytes | Latest random output |

## Build Exclusion

This directory is excluded from the Next.js TypeScript build via `tsconfig.json` — it's reference source only.
