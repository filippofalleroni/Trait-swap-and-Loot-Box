# Loot Box Commit-Reveal Smart Contract

This directory contains the TEALScript source for the commit-reveal randomness contract used by the loot box system.

## Overview

The contract implements a commit-reveal pattern using the [Algorand Randomness Beacon](https://developer.algorand.org/docs/get-details/randomness-beacon/). The user commits (recording the current round), waits at least 8 rounds, then reveals to read the VRF seed from the block after their commit. The VRF seed is already cryptographically random, so we extract a `uint64` directly.

### VRF Round Expiry

Algorand only retains block headers for approximately 1000 rounds. If a user commits but doesn't reveal within that window, the VRF seed becomes inaccessible. The contract enforces a 900-round expiry (conservative buffer) and provides a `reclaim()` method so users can clean up expired commits and recommit.

### Multiple Random Values

If you need multiple random values from a single seed (e.g. rolling several dice in one transaction), use [lib-pcg-avm](https://github.com/CiottiGiorgio/lib-pcg-avm) by Giorgio Ciotti — an open-source PCG implementation for the Algorand Virtual Machine that handles overflow-safe multiplication and proper PRNG state management.

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

## Contract Methods

| Method | Description |
|--------|-------------|
| `commit()` | Records the current round for the caller. Can be called again to reset. |
| `reveal()` | Reads the VRF seed from `blocks[committed+1]`, returns a random `uint64`, deletes the commit. Fails if called before 8 rounds or after 900 rounds. |
| `reclaim()` | Deletes an expired commit (900+ rounds old) so the user can recommit. |

## Build Exclusion

This directory is excluded from the Next.js TypeScript build via `tsconfig.json` — it's reference source only.
