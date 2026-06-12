# Algorand TraitSwap & LootBox

An open-source template for adding **trait swapping** (ARC-19 metadata updates) and a **loot box** with verifiable on-chain randomness to any Algorand NFT collection. White-label ready -- configure it for your project and deploy.

The loot box ships with **two randomness backends** — pick the trade-off that fits your prizes:

| Mode | Trust model | Signatures | Speed | Setup |
|---|---|---|---|---|
| **`block-seed`** (default) | Verifiable from public chain data; biasing requires proposing consecutive blocks | 1 | ~10 s | None — just env vars |
| **`beacon`** | Fully trustless VRF (no party, including block proposers, can bias the draw) with an on-chain audit trail | 2 + short wait | ~45 s | Deploy the included smart contract |

---

## Features

- **Trait Lab** -- Browse, preview, and apply new traits to your NFTs. Traits are composited as layered PNG images and the resulting metadata is uploaded to IPFS. The on-chain ARC-19 reserve address is updated so wallets and explorers display the new image instantly.
- **Loot Box** -- Verifiable on-chain randomness with two selectable backends: fast single-signature **block-seed** draws (no contract to deploy) or the fully trustless **Randomness Beacon** commit-reveal contract. Supports tiered prizes including fungible tokens, ALGO, and unique NFTs, with weighted probability and rarity tiers. Winners opt in to only the asset they actually win.
- **Admin Panel** -- Manage prize configurations, view treasury and master wallet balances, opt the master wallet in to new assets, and inspect prize pool inventory. Access is gated by wallet signature authentication.
- **Wallet Integration** -- Pera, Defly, and Lute wallet support via `@txnlab/use-wallet`.
- **Preview Mode** -- Develop and test safely. Both trait swapping and loot box run in preview mode by default, simulating the full flow without on-chain changes.
- **White-Label Ready** -- All configuration lives in the `config/` directory. Swap out addresses, traits, prizes, site name, and colors to make it your own.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14 (App Router) |
| Blockchain | Algorand (algosdk v3) |
| Wallets | Pera, Defly, Lute via `@txnlab/use-wallet` |
| NFT Standard | ARC-19 (mutable metadata via reserve address) |
| IPFS | Pinata pinning API |
| Image Composition | sharp (server-side PNG layering) |
| Smart Contract | Algorand TypeScript / Puya (commit-reveal with VRF) |
| Styling | Tailwind CSS |
| Deployment | Vercel (recommended) or self-hosted |

---

## Quick Start

### Prerequisites

- **Node.js 18+** (recommended: Node.js 20)
- **npm**
- An Algorand wallet -- **Pera**, **Defly**, or **Lute**

### Setup

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd algorand-traitswap-lootbox

# 2. Install dependencies
npm install

# 3. Copy the example environment file
cp .env.example .env.local

# 4. Configure environment variables (see section below)

# 5. Start the development server
npm run dev

# 6. Open http://localhost:3000
```

The app starts in **preview mode** by default -- trait swaps and loot box openings are simulated without making real on-chain changes.

---

## Going Live (Loot Box)

The default **block-seed** mode needs no smart contract — going live is just configuration:

1. **Create a master wallet** (separate from your manager wallet), fund it with ALGO for transaction fees and min-balance, and send it the prize tokens/NFTs. Set `LOOTBOX_MASTER_MNEMONIC`.
2. **Set your treasury** — `TREASURY_ADDRESS` receives the crate payments.
3. **Configure prizes** — edit `config/lootbox.ts` (asset IDs, amounts, weights, rarities) or use the admin panel at `/lootbox/admin` (set `NEXT_PUBLIC_ADMIN_WALLETS`; add `BLOB_READ_WRITE_TOKEN` so prize edits persist across deploys).
4. **Set the price** — `LOOTBOX_PRICE_ALGO`, and keep `cratePrice` / `cratePriceMicroAlgo` in `config/lootbox.ts` in sync (the UI shows the config values).
5. **Test on TestNet** — point the `NEXT_PUBLIC_*` node URLs at TestNet, set `LOOTBOX_LIVE_ENABLED=true`, and click through a full open with a test wallet.
6. **Flip to MainNet** — switch the node URLs back, redeploy, open one loot box yourself end-to-end.

For **beacon** mode, do all of the above plus deploy the contract ([Smart Contract Deployment](#smart-contract-deployment-beacon-mode-only)) and set `LOOTBOX_RANDOMNESS_MODE=beacon` and `LOOTBOX_CONTRACT_APP_ID`.

---

## Environment Variables

Copy `.env.example` to `.env.local` and configure:

### Algorand Node

| Variable | Description | Default |
|---|---|---|
| `NEXT_PUBLIC_ALGORAND_NETWORK` | Network for wallet connections: `mainnet`, `testnet`, or `localnet`. Must match the algod/indexer URLs. | `mainnet` |
| `NEXT_PUBLIC_ALGOD_URL` | Algorand node API URL. Use `https://testnet-api.4160.nodely.dev` for development. | `https://mainnet-api.4160.nodely.dev` |
| `NEXT_PUBLIC_INDEXER_URL` | Algorand indexer API URL. Must match the same network as the algod URL. | `https://mainnet-idx.4160.nodely.dev` |

### Trait Swapping

| Variable | Description | Default |
|---|---|---|
| `MANAGER_MNEMONIC` | 25-word mnemonic for the collection's **manager wallet**. This wallet must be set as the manager address on every NFT ASA. Used server-side only. | *(required)* |
| `PINATA_JWT` | JWT token from [Pinata](https://app.pinata.cloud) for IPFS uploads. Navigate to API Keys and generate a new key. | *(required)* |
| `TREASURY_ADDRESS` | Algorand address that receives trait swap and loot box fees. | *(required)* |
| `COLLECTION_CREATOR_ADDRESS` | Algorand address of the NFT collection creator. Used to validate that assets belong to your collection during ARC-19 updates. Leave blank to skip creator validation. | *(empty)* |
| `ARC19_LIVE_UPDATES_ENABLED` | Set to `"true"` to enable real on-chain ARC-19 metadata updates. When `"false"`, the mint endpoint runs in preview mode. | `false` |

### Loot Box

| Variable | Description | Default |
|---|---|---|
| `LOOTBOX_MASTER_MNEMONIC` | 25-word mnemonic for the prize distribution wallet. Holds all prize tokens/NFTs and sends them to winners. **Use a separate wallet from the manager.** | *(required for loot box)* |
| `LOOTBOX_RANDOMNESS_MODE` | Randomness backend: `block-seed` (one signature, no contract) or `beacon` (the on-chain commit-reveal contract — requires `LOOTBOX_CONTRACT_APP_ID`). | `block-seed` |
| `LOOTBOX_BLOCK_SEED_COUNT` | Block-seed mode only: how many consecutive block seeds are hashed into each draw. Biasing a result requires proposing this many consecutive blocks — raise it for higher-value prizes, or set `1` for maximum speed. | `2` |
| `LOOTBOX_CONTRACT_APP_ID` | Beacon mode only: application ID of your deployed commit-reveal smart contract. Not used in block-seed mode. | `0` |
| `LOOTBOX_LIVE_ENABLED` | Set to `"true"` to enable real prize distribution. When `"false"`, prizes are resolved but not distributed on-chain. | `false` |
| `LOOTBOX_PRICE_ALGO` | Price in ALGO to open one loot box. Keep this in sync with `cratePrice` / `cratePriceMicroAlgo` in `config/lootbox.ts` (the UI displays the config values; the server enforces this one). | `10` |
| `LOOTBOX_PAUSED` | Set to `"true"` to temporarily pause loot box opens (returns 503). | `false` |

### Admin & Access Control

| Variable | Description | Default |
|---|---|---|
| `NEXT_PUBLIC_ADMIN_WALLETS` | Comma-separated Algorand wallet addresses that can access the admin panel. Overrides the hardcoded list in `config/admin.ts` when set. Requires the `NEXT_PUBLIC_` prefix because the admin gate runs client-side. | *(empty)* |

### Optional

| Variable | Description | Default |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob storage token. Persists prize configuration across deployments, and enables durable trait-swap replay protection: spent payments are permanently marked as consumed, which lets a paid-but-failed swap be retried for up to 7 days without being charged again. Without this, replay tracking is in-memory only and failed swaps must be retried within 5 minutes. | *(empty)* |
| `LOOTBOX_PRIZES_BLOB_URL` | Optional fallback URL to the Blob-stored prize JSON. When `BLOB_READ_WRITE_TOKEN` is set, the prize and reveal routes automatically find admin-saved prizes via the Blob SDK. Only needed if automatic lookup fails. | *(empty)* |

---

## Configuration Files

Customize these files in the `config/` directory before deploying:

| File | Purpose |
|---|---|
| `config/collection.ts` | Set your collection's **creator address**, unit name prefix, and size. The creator address determines which NFTs are recognized as belonging to your collection. |
| `config/lootbox.ts` | Define prize tiers with asset IDs, amounts, weights, rarity levels, and display colors. Also sets crate price and commit delay rounds. |
| `config/fees.ts` | Configure the trait removal fee (default: 5 ALGO) and estimated transaction fee parameters. |
| `config/admin.ts` | Hardcode admin wallet addresses (alternative to the `NEXT_PUBLIC_ADMIN_WALLETS` env var). |
| `config/mock-data.ts` | Define available traits with IDs, names, categories, rarity, prices, and image paths. Replace with a database-backed registry for production. |
| `config/site.ts` | Set the site name and description displayed in the UI. |

---

## How Trait Swapping Works

1. **User connects wallet** and selects an NFT from the collection.
2. **Browse traits** -- The Trait Lab displays available traits organized by layer category (Background, Skin, Body, Eyes, Mouth, Top, Companion).
3. **Preview** -- Trait layers are composited client-side as stacked transparent PNGs so the user sees the result before paying.
4. **Payment** -- The server builds an unsigned payment transaction (user to treasury) with a `traitswap:` note prefix for replay prevention. The user signs it in their wallet.
5. **Verify payment** -- The server confirms the payment on-chain via the indexer, checking sender, receiver, amount, and note prefix. It also verifies the user owns the NFT.
6. **Compose image** -- The server composites all trait layers into a single PNG using `sharp`, resolving layer images from the local filesystem or deployed URL.
7. **Update metadata** -- The server uploads the composed image and new metadata JSON to IPFS via Pinata, computes the ARC-19 reserve address from the new CID, and signs an asset config transaction with the manager wallet to update the ASA's reserve address.
8. **Done** -- The NFT's on-chain metadata pointer now references updated content. Any ARC-19-aware wallet or explorer displays the new image.

Trait removal follows the same flow but clears the trait from the metadata properties instead of adding one.

If the update fails after the payment confirmed (network interruption, timeout), the payment is not lost: the UI offers a **Retry** button and a recovery banner that survives page reloads. Retrying re-verifies the original payment and completes exactly the swap that was paid for — the NFT and trait are stored with the pending payment — without charging again.

---

## How the Loot Box Works

Both modes share the same skeleton: the user pays the crate price to the treasury, a verifiably random value is drawn from the chain, the server maps it onto the weighted prize pool, and the master wallet delivers the prize. They differ in where the randomness comes from.

If the winner isn't opted in to the won asset, the server responds with `needs-optin` and the client signs a single free opt-in for **just that asset** before delivery — wallets are never pre-filled with every prize asset. The draw is a pure function of on-chain data, so the post-opt-in retry recomputes the same prize without any server-side state.

### Block-seed mode (default — 1 signature, ~10 seconds)

1. **User clicks "Open Loot Box"** and signs a single payment (crate price to treasury). That's the only signature.
2. **Wait for fresh blocks** -- The server waits for the next `LOOTBOX_BLOCK_SEED_COUNT` blocks after the payment's confirmed round.
3. **Draw** -- The random value is `sha256(seed(C+1) ‖ … ‖ seed(C+N) ‖ paymentTxId)`, where `C` is the payment's confirmed round and each `seed` is that block's 32-byte VRF seed. The seeds don't exist yet when the user signs (unpredictable), the payment txid binds the draw to this specific open (two buyers in the same round get independent results), and anyone can recompute the value from public chain data to verify their prize.
4. **Distribution** -- The master wallet sends the prize (ALGO, token, or NFT transfer) to the user.

**Trust model:** the only party who could influence a draw is a block proposer controlling all `N` consecutive blocks after the payment — and even then only by discarding otherwise-valid blocks. With the default `N = 2` this is infeasible without an enormous stake share. For most prize pools this is plenty; for very high-value prizes, raise `LOOTBOX_BLOCK_SEED_COUNT` or use beacon mode.

### Beacon mode (fully trustless — 2 signatures, ~45 seconds)

1. **Commit** -- The server builds an atomic group: a payment to the treasury plus an application call to the contract's `commit(payment)` method. The contract verifies the payment and locks a *future* Randomness Beacon round in box storage. One signature covers the group.
2. **Wait** -- The client waits for the Beacon to publish the target round (a progress indicator shows remaining rounds).
3. **On-chain reveal** -- The user signs a `reveal()` app call. The contract fetches the target round's VRF value from the Randomness Beacon (bound to the caller's address), deletes the commit box, and returns a random `uint64` via ABI return — also emitted as an ARC-28 `Revealed` event, so every draw has a permanent on-chain audit trail.
4. **Server verification** -- The server verifies the reveal transaction via the indexer, reads the ABI return value from the logs, and uses it for weighted prize selection.
5. **Distribution** -- The master wallet sends the prize to the user.

**Trust model:** the Beacon's VRF value for a round locked at commit time cannot be influenced by anyone — not the operator, not block proposers. This is the maximum-trust option, at the cost of a second signature, a short wait, and deploying the contract.

### The Commit-Reveal Contract (beacon mode)

The smart contract (in `contracts/lootbox-commit-reveal/`) implements:

| Method | Description |
|---|---|
| `createApplication(treasury, price, beaconApp, beaconCadence)` | Deploy-time setup. Stores the treasury, crate price, Randomness Beacon app id, and Beacon cadence in global state. |
| `configure(treasury, price)` | Creator-only. Updates treasury address and/or crate price after deployment. |
| `commit(payment)` | Takes the payment as a transaction argument and verifies it (correct receiver, amount, sender). Rejects if the sender already has an active commit. Records the current round and emits a `Committed` ARC-28 event. |
| `reveal()` | Deterministically derives a future Beacon round from the commit, fetches its VRF value from the Randomness Beacon's `must_get` (bound to the caller's address for per-caller independence), extracts a random `uint64`, deletes the commit box, and returns the value. Reverts before the target round and after the 400-round expiry. |
| `reclaim(target)` | Permissionless cleanup of any **expired** commit (past the 400-round window). Frees the box and returns its MBR to the app account, so abandoned commits can't accumulate. |
| `withdraw(amount)` | Creator-only recovery of freed box MBR / excess funding from the app account. The AVM keeps outstanding commit boxes funded. |

The randomness comes from the Algorand Randomness Beacon's VRF, which could not have been known at commit time, making results verifiable and tamper-resistant — and, unlike the raw block seed, not biasable by block proposers. The user calls `reveal()` on-chain themselves -- the server reads the ABI return value from the confirmed transaction's logs, ensuring the random number is generated by the Beacon and verifiable by anyone.

The contract account must be funded with enough ALGO to cover box MBR for the maximum number of concurrent outstanding commits. Commit boxes are automatically deleted when `reveal()` succeeds. If a user abandons a commit, `reclaim()` can clean it up after 900 rounds.

---

## Smart Contract Deployment (beacon mode only)

Block-seed mode needs **no contract** — skip this section entirely unless you set `LOOTBOX_RANDOMNESS_MODE=beacon`.

For beacon mode, deploy your own instance of the commit-reveal contract before enabling live loot box mode. Full instructions are in [`contracts/README.md`](contracts/README.md).

Summary:

```bash
# Pre-compiled artifacts are included -- you only need to recompile if
# you modify the contract source.

# (Optional) Recompile with the Puya compiler -- run from the contracts/ directory
cd contracts
npm install
npm run build   # algokit compile ts lootbox-commit-reveal --output-source-map --out-dir artifacts

# Deploy using AlgoKit or goal
# createApplication requires: treasury, crate price (microALGO),
# Randomness Beacon app id (600011887 TestNet / 1615566206 MainNet), Beacon cadence (8)
algokit deploy

# Fund the contract account for box MBR (see contracts/README.md)

# Set the mode + app ID in .env.local
LOOTBOX_RANDOMNESS_MODE=beacon
LOOTBOX_CONTRACT_APP_ID=<your-app-id>
LOOTBOX_LIVE_ENABLED=true
```

Test on LocalNet first:

```bash
algokit localnet start
```

---

## Preview vs Live Mode

The template runs in **preview mode** by default for both features:

| Feature | Preview Behavior | Live Behavior | Env Var to Enable |
|---|---|---|---|
| Trait Swap | Payment is verified but no IPFS upload or on-chain update occurs. Returns a preview response. | Full flow: IPFS upload, ARC-19 reserve address update on-chain. | `ARC19_LIVE_UPDATES_ENABLED=true` |
| Loot Box | Payment is sent to treasury (real ALGO is spent). Prize is resolved locally using server-side randomness. Not distributed on-chain. | Verifiable on-chain randomness (block seeds or Beacon VRF, per `LOOTBOX_RANDOMNESS_MODE`). Prize distributed from master wallet. | `LOOTBOX_LIVE_ENABLED=true` |

This lets you develop the UI, test wallet integration, and verify payment flows without risking real assets.

---

## Security

### Payment & Transaction Safety

Every payment is verified on-chain via the indexer before proceeding. The server checks sender, receiver, amount, transaction type, note prefix, and age. Transactions with `rekey-to` or `close-remainder-to` fields are rejected. Overpayments (>2x expected) are flagged. In beacon mode, the smart contract additionally verifies the payment inside the atomic group, so no one can commit without paying.

Trait swap and loot box payments use different note prefixes (`traitswap:` and `lootbox:`) so one cannot be replayed as the other. Loot box distribution is **idempotent**: each payout is keyed to its payment transaction ID and recorded in the on-chain distribution note, so resubmitting a completed open returns the original result instead of paying out a second time.

### Randomness

In live mode the server never generates randomness itself — there is no server-side fallback.

- **Block-seed mode:** the draw is `sha256` over the VRF seeds of blocks produced *after* the payment confirms, mixed with the payment txid. The seeds are unknowable when the user signs, the txid makes every draw independent, and the inputs are public — anyone can recompute and verify any result. Influencing a draw requires proposing all `LOOTBOX_BLOCK_SEED_COUNT` consecutive blocks after the payment.
- **Beacon mode:** randomness comes from the Algorand Randomness Beacon (a VRF oracle) for a round locked at commit time, fetched on-chain by the smart contract and read from the confirmed reveal transaction's ABI return value. No party can bias it, and every draw is logged as an ARC-28 event.

### Reliability

If the browser closes mid-flow, pending state is saved to `localStorage`. On return the UI resumes from where the user left off. Prize distribution retries up to 3 times with delays between attempts, resending the *same* signed transaction so a confirmation timeout can never pay out twice. Before sending — and before processing any retry — the server checks the indexer for an existing payout tied to that payment, and every distribution carries a **lease** derived from the payment txid: the chain itself confirms at most one transaction per (sender, lease) within a validity window, so even two concurrent server instances cannot double-pay. If a won one-of-one NFT becomes undeliverable in the moment between the draw and the transfer (a concurrent winner took the last copy), the same random value is re-mapped over the always-in-stock token tiers so a paid buyer is never left with nothing. If a trait swap fails after payment (e.g. IPFS timeout), the transaction ID is released so the user can retry with the same payment.

### Server-Side Security

All wallet mnemonics (`MANAGER_MNEMONIC`, `LOOTBOX_MASTER_MNEMONIC`) are used only in server routes and never bundled into client JavaScript. Every server module that handles secrets imports `"server-only"` as a build-time guard. API routes have per-wallet and per-IP rate limiting. Metadata fetching blocks SSRF attempts against localhost, private IPs, and cloud metadata endpoints. Error messages are mapped to user-friendly text before returning to the client.

### Admin Panel

Admin access requires signing a challenge nonce with the wallet's Ed25519 key. The signature is cryptographically verified against the sender's public key over the exact signed bytes, and the transaction is validated for type, zero amount, self-payment, and absence of rekey/close fields. Sessions expire after 1 hour.

### Production Recommendations

- **Persistent replay protection (trait swap)** -- Set `BLOB_READ_WRITE_TOKEN` so used payment transaction IDs are durably marked in Vercel Blob: spent payments can never be replayed, and a paid swap whose update failed stays retryable for 7 days (the user is never charged twice). Without the token, used IDs are tracked in memory only (resets on restart) and a tight 5-minute payment-age window is the only cross-instance replay guard. (Loot box distribution does not depend on this — it is made idempotent on-chain via the payment-keyed distribution note, so it survives restarts and cold starts; see [Reliability](#reliability) above.)
- **Session persistence** -- Admin sessions are in-memory. Use encrypted httpOnly cookies or a session store for production.
- **Persistent rate limiting** -- The in-memory rate limiters reset on restart. Use edge middleware or a distributed store for production.
- **Smart contract audit** -- The included contract is a reference implementation. Have it reviewed before deploying with real funds.

---

## Deployment

### Vercel (Recommended)

1. Push to GitHub.
2. Import the repository at [vercel.com](https://vercel.com).
3. Add all environment variables under **Settings > Environment Variables**. Keep server-side variables (`MANAGER_MNEMONIC`, `LOOTBOX_MASTER_MNEMONIC`, `PINATA_JWT`) as regular env vars -- never prefix them with `NEXT_PUBLIC_`.
4. Deploy.

**Note:** The mint and reveal API routes use `maxDuration = 60` (60-second timeout) for indexer retry loops. On Vercel's Hobby plan, the maximum is 10 seconds. A **Pro plan** (or self-hosting) is recommended for live mode.

For persistent prize configuration across redeployments, configure `BLOB_READ_WRITE_TOKEN` with [Vercel Blob storage](https://vercel.com/docs/storage/vercel-blob).

### Self-Hosted

```bash
npm run build
npm start
```

The server listens on port 3000 by default (configure with the `PORT` env var). All environment variables must be set in the shell or `.env.local`.

---

## Project Structure

```
app/
  page.tsx                          Home page
  layout.tsx                        Root layout (providers, header, footer)
  globals.css                       Global styles (Tailwind + dark theme)
  trait-lab/page.tsx                Trait Lab UI
  lootbox/page.tsx                  Loot Box UI
  lootbox/admin/page.tsx            Loot box admin panel
  actions/admin.ts                  Server actions: auth, prizes, opt-in, revenue
  api/
    trait-lab/payment-tx/route.ts   Build unsigned payment for trait swap
    trait-lab/mint/route.ts         Verify payment, update ARC-19 metadata
    lootbox/commit/route.ts         Build the unsigned open transactions (per randomness mode)
    lootbox/build-reveal/route.ts   Build unsigned reveal app call (beacon mode only)
    lootbox/reveal/route.ts         Draw randomness, resolve & distribute the prize
    lootbox/prizes/route.ts         Return prize list with probabilities
    lootbox/buyer-balance/route.ts  Prize pool wallet ALGO balance
    owned-nfts/route.ts             Query wallet's collection NFTs
    nfd/route.ts                    NFD name resolution proxy
    trait-counts/route.ts           Trait popularity counts

components/
  trait-swapper.tsx                  Trait Lab main component
  lootbox-studio.tsx                Loot Box main component
  lootbox-admin.tsx                 Admin prize management panel
  nft-layered-image.tsx             Composited NFT layer renderer
  admin-gate.tsx                    Wallet-signature admin auth gate
  wallet-gate.tsx                   Wallet connection gate
  connect-wallet-button.tsx         Wallet connect/disconnect button
  header.tsx                        Navigation header with active links
  footer.tsx                        Site footer
  providers.tsx                     Client-side provider wrapper

config/                             All customizable configuration (see above)

contracts/
  lootbox-commit-reveal/
    contract.algo.ts                Algorand TypeScript (Puya) commit-reveal contract (beacon mode)
    artifacts/                      Pre-compiled TEAL, ARC-32/ARC-56 app specs, source map
  tsconfig.json                     Puya compiler config (excluded from Next.js build)

contexts/
  wallet-context.tsx                Wallet provider (Pera/Defly/Lute)
  toast-context.tsx                 Toast notification system

lib/
  algorand.ts                       Algod/Indexer clients + ARC-19 URL resolution
  arc19-update.ts                   CID-to-address conversion + reserve updater
  lootbox-distributor.ts            Prize ALGO/ASA transfer from master wallet
  lootbox-master-wallet.ts          Load master wallet from env mnemonic
  lootbox-prize-resolver.ts         Weighted random prize selection
  lootbox-prize-store.ts            Load prizes from Vercel Blob or config
  manager-signer.ts                 Load manager wallet from env mnemonic
  nft-compose.ts                    Server-side image composition (sharp)
  nft-layering.ts                   Layer order + trait name sanitization
  pinata.ts                         IPFS upload via Pinata
  security.ts                       SSRF hostname blocklist for metadata fetching
  treasury.ts                       Treasury address getter
  format.ts                         ALGO formatting + address utilities
  types.ts                          TypeScript types
```

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the development server with hot reload |
| `npm run build` | Build the production bundle |
| `npm start` | Start the production server |
| `npm run lint` | Run Next.js linting |

---

## Contributing

Contributions are welcome.

1. **Fork** the repository.
2. **Create a branch** for your feature or fix.
3. **Make changes** and test locally.
4. **Commit** with a clear message.
5. **Open a Pull Request** against `main`.

### Ideas for Contributions

- Unit tests for prize resolution and ARC-19 address computation
- Database-backed trait registry (replacing `mock-data.ts`)
- Support for ARC-69 metadata in addition to ARC-19
- Additional wallet support (Exodus, WalletConnect v2)

---

## License

This project is released under the [MIT License](LICENSE).

---

## Credits

- Commit-reveal randomness uses the [Algorand Randomness Beacon](https://developer.algorand.org/docs/get-details/randomness-beacon/) (VRF seed extraction). For multiple random values from a single seed, see [lib-pcg-avm](https://github.com/CiottiGiorgio/lib-pcg-avm) by Giorgio Ciotti.
- Built with [Next.js](https://nextjs.org/), [Algorand SDK](https://github.com/algorand/js-algorand-sdk), [Tailwind CSS](https://tailwindcss.com/), and [@txnlab/use-wallet](https://github.com/TxnLab/use-wallet)
- IPFS pinning by [Pinata](https://pinata.cloud)
- Free Algorand node access by [Nodely](https://nodely.io)
