# Loot Box Commit-Reveal Smart Contract

This directory contains the Algorand TypeScript (Puya) source for the commit-reveal randomness contract used by the loot box system.

## Overview

The contract implements a commit-reveal pattern backed by the **Algorand Randomness Beacon** (an ARC-21 VRF oracle — app `600011887` on TestNet, `947461882` on MainNet). It enforces payment, derives verifiable randomness from the Beacon, and returns the result on-chain — the server never generates the randomness itself. Using the Beacon (rather than the raw block seed) means the outcome cannot be biased by block proposers, which is the recommended approach for value-bearing randomness.

### Flow

1. **Commit**: The user sends an atomic group containing a payment to the treasury (for at least the crate price) and an app call to `commit(payment)` that references that payment as its transaction argument. The contract verifies the payment, **deterministically** computes a future Beacon round (`target = (commitRound / cadence + 2) × cadence`), and stores that target round in the user's box — locking it so later config changes can't move it.
2. **Wait**: The user waits until the Beacon has published the target round — a short wait of roughly `2 × cadence` rounds.
3. **Reveal**: The user calls `reveal()` on-chain. The contract reads the locked target round and fetches its VRF value from the Beacon via `must_get(round, user_data)` — passing the caller's address as `user_data` so each account gets an independent draw — extracts a random `uint64`, deletes the commit box, and returns the value via ABI return. Because the target round was computed by the contract (not chosen by the caller), the outcome cannot be ground by picking a favourable round.
4. **Distribute**: The server verifies the on-chain reveal transaction, reads the ABI return value from the transaction logs, and uses it to determine the prize.

### Payment Enforcement

The `commit(payment)` method takes the payment as an ARC-4 transaction argument and verifies it pays the treasury at least the configured crate price, from the same account that is committing. This means:

- The contract **enforces** that every commit is paid for — no one can call `commit()` without paying.
- The treasury address, crate price, Beacon app id, and Beacon cadence are stored in global state and set at deployment via `createApplication()`.
- Only the contract creator can update them via `configure()`.

### Double-Commit Protection

The contract rejects `commit()` if the sender already has an active commit box. Without this, a second commit would silently overwrite the first, losing the original payment. Users must call `reveal()` or `reclaim()` before they can commit again.

### Round Expiry

The Beacon retains randomness for a limited window. The contract enforces a conservative 400-round expiry and provides a permissionless `reclaim()` so anyone can clean up expired commits and free their box MBR. An expired commit can never be revealed, so allowing anyone to sweep it is safe and prevents the contract from accumulating dead boxes from abandoned commits.

### Box Storage and MBR

Each commit creates a BoxMap entry (32-byte address key + 8-byte uint64 value). The minimum balance requirement (MBR) for each box is approximately 18,500 microALGO. The contract account must be funded with enough ALGO to cover MBR for the maximum number of concurrent commits expected. When a commit is deleted (via `reveal()` or `reclaim()`), the associated MBR is freed; the creator can recover it with `withdraw()`.

**Important:** Set the crate price to at least the per-box MBR (≈ 18,500 microALGO) so that committing always covers the box it creates.

### Economic note (abandonment)

As with any public commit-reveal, once the Beacon round is published a player can compute their outcome before submitting `reveal()` and abandon a bad result (paying only the crate price each time). Price crates so that even a player who only ever claims the top prize has negative expected value — i.e. `top_prize_value < crate_price ÷ top_prize_probability`.

### Multiple Random Values

The contract returns a single raw `uint64`; the server maps it to a prize. If you instead need multiple random values from a single seed on-chain (e.g. rolling several dice in one transaction), use [lib-pcg-avm](https://github.com/CiottiGiorgio/lib-pcg-avm) by Giorgio Ciotti.

## Deploying Your Own

### Prerequisites

- [AlgoKit](https://developer.algorand.org/docs/get-started/algokit/) installed (provides the Puya compiler)
- Node.js 22+

Pre-compiled artifacts are included in the `artifacts/` directory (ARC-32 / ARC-56 app specs, approval/clear TEAL, and Puya source maps). You only need to recompile if you modify the contract.

### Steps

1. Install the compiler toolchain and build (run from the `contracts/` directory):
   ```bash
   cd contracts
   npm install
   npm run build   # algokit compile ts lootbox-commit-reveal --output-source-map --out-dir artifacts
   ```

2. Deploy using AlgoKit or `goal`. The `createApplication` call takes four arguments:
   - `treasury` — the Algorand address that receives crate payments
   - `price` — the crate price in microALGO (e.g. `10000000` for 10 ALGO)
   - `beaconApp` — the Randomness Beacon app id for your network (`600011887` TestNet, `947461882` MainNet)
   - `beaconCadence` — the Beacon's publishing cadence in rounds (the official Beacon publishes every `8` rounds)

3. **Fund the contract account** with enough ALGO to cover box MBR for concurrent commits (≈ 18,500 microALGO each), plus the account minimum balance (100,000 microALGO).

4. Set the deployed app ID in your `.env.local`:
   ```
   LOOTBOX_CONTRACT_APP_ID=<your-app-id>
   ```

5. Enable live mode:
   ```
   LOOTBOX_LIVE_ENABLED=true
   ```

> **Reveal transactions** make an inner call to the Beacon, so the reveal app call must reference the Beacon app and carry enough fee to cover the inner transaction (use AlgoKit's resource population / inner-fee coverage, or add `extraFee`).

### Updating Configuration

To change the treasury, price, Beacon app id, or cadence after deployment, call `configure(treasury, price, beaconApp, beaconCadence)` from the creator account.

### Testing

```bash
npm test   # vitest — unit tests (@algorandfoundation/algorand-typescript-testing)
```

The unit suite (`contract.algo.spec.ts`) covers everything deterministic:
config validation, creator-only access control, the `commit(payment)`
verification (receiver / amount / sender / double-commit), the `reveal` guards
(no commit / before the target round / expired), the `reclaim` lifecycle
(including permissionless sweep of expired commits), and `withdraw` access
control.

The live `reveal()` path makes an inner call to the Randomness Beacon, which is
**not** available on LocalNet and can't be emulated in unit tests — it is
validated **end-to-end on TestNet** (Beacon app `600011887`). App development can
use the app's preview mode, which doesn't touch the contract.

## Contract Methods

| Method | Description |
|--------|-------------|
| `createApplication(treasury, price, beaconApp, beaconCadence)` | Deploy-time setup. Stores the treasury, crate price, Beacon app id, and Beacon cadence in global state. |
| `configure(treasury, price, beaconApp, beaconCadence)` | Creator-only. Updates any of the above. |
| `commit(payment)` | Takes the payment as a transaction argument and verifies it (correct receiver, amount, sender). Rejects if the sender already has an active commit. Records the current round and emits `Committed`. |
| `reveal()` | Deterministically derives a future Beacon round from the commit, fetches its VRF value via the Beacon's `must_get` (bound to the caller's address), returns a random `uint64`, deletes the commit box, and emits `Revealed`. Reverts before the target round and after the 400-round expiry. |
| `reclaim(target)` | Deletes an **expired** commit for any account, freeing its box and returning the MBR to the app account. Permissionless — an expired commit can never be revealed, so anyone may sweep dead boxes. |
| `withdraw(amount)` | Creator-only. Sends `amount` microALGO from the app account to the creator (recovers freed box MBR / excess funding). The AVM keeps the app at or above its minimum balance, so outstanding commit boxes can never be under-funded. |

## Events (ARC-28)

The contract emits two ARC-28 events so off-chain indexers can follow the
lifecycle and anyone can audit fairness:

| Event | Fields | Emitted by |
|-------|--------|------------|
| `Committed` | `account: address`, `commitRound: uint64` | `commit(payment)` |
| `Revealed` | `account: address`, `beaconRound: uint64`, `value: uint64` | `reveal()` |

A `Revealed` event is independently verifiable: anyone can call the Beacon's
`must_get(beaconRound, account)` and confirm `value == extractUint64(result)`.

## Build Exclusion

This directory is a self-contained Puya project with its own `package.json` and `node_modules`, separate from the Next.js app. It is excluded from the Next.js TypeScript build, so the `@algorandfoundation/algorand-typescript` import is only resolved when building the contract from within `contracts/`.
