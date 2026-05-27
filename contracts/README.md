# Loot Box Commit-Reveal Smart Contract

This directory contains the TEALScript source for the commit-reveal randomness contract used by the loot box system.

## Overview

The contract implements a commit-reveal pattern using the [Algorand Randomness Beacon](https://developer.algorand.org/docs/get-details/randomness-beacon/). It enforces payment, generates verifiable randomness, and returns the result on-chain — the server never touches the VRF seed directly.

### Flow

1. **Commit**: The user sends an atomic group containing a payment to the treasury (for at least the crate price) followed by an app call to `commit()`. The contract verifies the payment and records the current round.
2. **Wait**: The user waits at least 9 rounds for the VRF seed to become available (the contract requires `globals.round > committed + 8`, i.e. strictly greater).
3. **Reveal**: The user calls `reveal()` on-chain. The contract reads the VRF seed from `blocks[committed+1]`, extracts a random `uint64`, deletes the commit box, and returns the value via ABI return.
4. **Distribute**: The server verifies the on-chain reveal transaction, reads the ABI return value from the transaction logs, and uses it to determine the prize.

### Payment Enforcement

The `commit()` method verifies that the preceding transaction in the atomic group is a payment to the treasury address for at least the configured crate price, from the same sender. This means:

- The contract **enforces** that every commit is paid for — no one can call `commit()` without paying.
- The treasury address and crate price are stored in global state and set at deployment via `createApplication()`.
- Only the contract creator can update them via `configure()`.

### Double-Commit Protection

The contract rejects `commit()` if the sender already has an active commit box. Without this, a second commit would silently overwrite the first, losing the original payment. Users must call `reveal()` or `reclaim()` before they can commit again.

### VRF Round Expiry

Algorand only retains block headers for approximately 1000 rounds. If a user commits but doesn't reveal within that window, the VRF seed becomes inaccessible. The contract enforces a 900-round expiry (conservative buffer) and provides a `reclaim()` method so users can clean up expired commits and recommit.

### Box Storage and MBR

Each commit creates a BoxMap entry (32-byte address key + 8-byte uint64 value). The minimum balance requirement (MBR) for each box is approximately 18,500 microALGO (2,500 base + 400 * 40 bytes). The contract account must be funded with enough ALGO to cover MBR for the maximum number of concurrent commits expected. When a commit is deleted (via `reveal()` or `reclaim()`), the associated MBR is freed.

**Important:** Set the crate price to at least 18,500 microALGO (0.0185 ALGO) to prevent MBR exhaustion attacks. If the crate price is lower than the per-box MBR cost, an attacker can consume more MBR than the treasury earns per commit, potentially blocking legitimate users.

### Multiple Random Values

If you need multiple random values from a single seed (e.g. rolling several dice in one transaction), use [lib-pcg-avm](https://github.com/CiottiGiorgio/lib-pcg-avm) by Giorgio Ciotti — an open-source PCG implementation for the Algorand Virtual Machine.

## Deploying Your Own

### Prerequisites

- [AlgoKit](https://developer.algorand.org/docs/get-started/algokit/) installed
- TEALScript compiler (`npm install --save-dev @algorandfoundation/tealscript`)

Pre-compiled TEAL artifacts are included in the `artifacts/` directory (ARC-32, ARC-56 app specs, approval/clear programs, and source map). You only need to recompile if you modify the contract.

### Steps

1. Compile the contract (run from the `contracts/` directory so it picks up the local `tsconfig.json`):
   ```bash
   cd contracts
   npx tealscript lootbox-commit-reveal/contract.algo.ts lootbox-commit-reveal/artifacts --skip-algod
   ```

2. Deploy using AlgoKit or `goal`. The `createApplication` call requires two arguments:
   - `treasury` — the Algorand address that receives crate payments
   - `price` — the crate price in microALGO (e.g. `10000000` for 10 ALGO)

3. **Fund the contract account** with enough ALGO to cover box MBR for concurrent commits. For example, to support 100 concurrent commits:
   ```
   100 * 18,500 = 1,850,000 microALGO = 1.85 ALGO
   ```
   Plus the account minimum balance (100,000 microALGO).

4. Set the deployed app ID in your `.env.local`:
   ```
   LOOTBOX_CONTRACT_APP_ID=<your-app-id>
   ```

5. Enable live mode:
   ```
   LOOTBOX_LIVE_ENABLED=true
   ```

### Updating Configuration

To change the treasury address or crate price after deployment, call `configure(treasury, price)` from the creator account.

### Testing Locally

Use AlgoKit LocalNet to test the contract before deploying to MainNet:

```bash
algokit localnet start
```

Then deploy to LocalNet and run the loot box flow end-to-end.

## Contract Methods

| Method | Description |
|--------|-------------|
| `createApplication(treasury, price)` | Deploy-time setup. Sets the treasury address and crate price in global state. |
| `configure(treasury, price)` | Creator-only. Updates the treasury address and/or crate price. |
| `commit()` | Verifies the preceding payment in the atomic group (correct receiver, amount, sender). Rejects if the sender already has an active commit. Records the current round. |
| `reveal()` | Reads the VRF seed from `blocks[committed+1]`, returns a random `uint64`, deletes the commit box. Requires at least 9 rounds to have passed (strict `>`). Fails after 900 rounds. |
| `reclaim()` | Deletes an expired commit (900+ rounds old) so the user can recommit. Frees the associated box MBR. |

## Build Exclusion

This directory is excluded from the Next.js TypeScript build via `tsconfig.json` — it's reference source only. The `@algorandfoundation/tealscript` import does not need to be installed in the project's `node_modules`.
