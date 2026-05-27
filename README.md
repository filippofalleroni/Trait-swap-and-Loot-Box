# Algorand TraitSwap & LootBox

An open-source template for adding **trait swapping** (ARC-19 metadata updates) and **loot box** (commit-reveal randomness) functionality to any Algorand NFT collection. White-label ready -- configure it for your project and deploy.

---

## Features

- **Trait Lab** -- Browse, preview, and apply new traits to your NFTs. Traits are composited as layered PNG images and the resulting metadata is uploaded to IPFS. The on-chain ARC-19 reserve address is updated so wallets and explorers display the new image instantly.
- **Loot Box** -- Commit-reveal loot box backed by Algorand's VRF randomness beacon. Supports tiered prizes including fungible tokens and unique NFTs, with weighted probability and rarity tiers.
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
| Smart Contract | TEALScript (commit-reveal with VRF) |
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
| `LOOTBOX_CONTRACT_APP_ID` | Application ID of the deployed commit-reveal smart contract. Set to `0` or leave empty for preview mode. | `0` |
| `LOOTBOX_LIVE_ENABLED` | Set to `"true"` to enable real prize distribution. When `"false"`, prizes are resolved but not distributed on-chain. | `false` |
| `LOOTBOX_PRICE_ALGO` | Price in ALGO to open one loot box. Overrides the value in `config/lootbox.ts`. | `10` |
| `LOOTBOX_PAUSED` | Set to `"true"` to temporarily pause loot box commits and reveals (returns 503). | `false` |

### Admin & Access Control

| Variable | Description | Default |
|---|---|---|
| `NEXT_PUBLIC_ADMIN_WALLETS` | Comma-separated Algorand wallet addresses that can access the admin panel. Overrides the hardcoded list in `config/admin.ts` when set. Requires the `NEXT_PUBLIC_` prefix because the admin gate runs client-side. | *(empty)* |

### Optional

| Variable | Description | Default |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob storage token for persisting prize configuration across deployments. Without this, prize config saves to `/tmp/` (resets on redeploy). | *(empty)* |
| `LOOTBOX_PRIZES_BLOB_URL` | Direct URL to the Blob-stored prize JSON. Required alongside `BLOB_READ_WRITE_TOKEN` for the reveal and prize routes to read admin-saved prize config. | *(empty)* |

---

## Configuration Files

Customize these files in the `config/` directory before deploying:

| File | Purpose |
|---|---|
| `config/collection.ts` | Set your collection's **creator address**, unit name prefix, and size. The creator address determines which NFTs are recognized as belonging to your collection. |
| `config/lootbox.ts` | Define prize tiers with asset IDs, amounts, weights, rarity levels, and display colors. Also sets crate price and commit delay rounds. |
| `config/fees.ts` | Configure the trait removal fee (default: 5 ALGO) and estimated transaction fee parameters. |
| `config/admin.ts` | Hardcode admin wallet addresses (alternative to the `ADMIN_WALLETS` env var). |
| `config/mock-data.ts` | Define available traits with IDs, names, categories, rarity, prices, and image paths. Replace with a database-backed registry for production. |
| `config/site.ts` | Set the site name and description displayed in the UI. |

---

## How Trait Swapping Works

1. **User connects wallet** and selects an NFT from the collection.
2. **Browse traits** -- The Trait Lab displays available traits organized by layer category (Background, Skin, Body, Eyes, Mouth, Top, Companion).
3. **Preview** -- Trait layers are composited client-side as stacked transparent PNGs so the user sees the result before paying.
4. **Payment** -- The server builds an unsigned payment transaction (user to treasury). The user signs it in their wallet.
5. **Verify payment** -- The server confirms the payment on-chain via the indexer, checking sender, receiver, and amount. It also verifies the user owns the NFT.
6. **Update metadata** -- The server uploads new metadata JSON to IPFS via Pinata, computes the ARC-19 reserve address from the new CID, and signs an asset config transaction with the manager wallet to update the ASA's reserve address.
7. **Done** -- The NFT's on-chain metadata pointer now references updated content. Any ARC-19-aware wallet or explorer displays the new image.

Trait removal follows the same flow but clears the trait from the metadata properties instead of adding one.

---

## How the Loot Box Works

1. **User clicks "Open Loot Box"** and opts in to any prize ASAs they have not yet opted in to.
2. **Commit phase** -- The server builds an atomic transaction group containing a payment (user pays crate price to treasury) and an application call to the smart contract's `commit()` method. The contract verifies the payment (correct receiver, amount, sender) before recording the commit. The user signs both transactions.
3. **Wait** -- The client polls the network and waits at least 9 rounds (~27 seconds) for the VRF seed to finalize. A progress indicator shows remaining rounds.
4. **On-chain reveal** -- The client requests an unsigned `reveal()` app call from the server, signs it, and submits it. The contract reads the VRF seed from `blocks[commitRound + 1]`, extracts a random `uint64`, deletes the commit box, and returns the value via ABI return.
5. **Server verification** -- The server verifies the on-chain reveal transaction via the indexer, reads the ABI return value from the transaction logs, and uses it for weighted prize selection.
6. **Distribution** -- In live mode, the master wallet sends the prize (token or NFT transfer) to the user. The result is displayed with a rarity-colored animation.

### Commit-Reveal Randomness

The smart contract (in `contracts/lootbox-commit-reveal/`) implements:

| Method | Description |
|---|---|
| `createApplication(treasury, price)` | Deploy-time setup. Sets the treasury address and crate price in global state. |
| `configure(treasury, price)` | Creator-only. Updates treasury address and/or crate price after deployment. |
| `commit()` | Verifies the preceding payment in the atomic group (correct receiver, amount, sender). Rejects if the sender already has an active commit. Records the current round. |
| `reveal()` | Reads the VRF seed from block `commitRound + 1`, extracts a random `uint64`, deletes the commit box, and returns the value. Requires at least 9 rounds to have passed (strict `>`). Fails after 900 rounds. |
| `reclaim()` | Cleans up expired commits (900+ rounds old) so users can recommit. Frees the associated box MBR. |

The randomness is derived from the Algorand VRF block seed, which could not have been known at commit time, making results verifiable and tamper-resistant. The user calls `reveal()` on-chain themselves -- the server reads the ABI return value from the confirmed transaction's logs, ensuring the random number is generated entirely by the smart contract and verifiable by anyone.

The contract account must be funded with enough ALGO to cover box MBR for the maximum number of concurrent outstanding commits. Commit boxes are automatically deleted when `reveal()` succeeds. If a user abandons a commit, `reclaim()` can clean it up after 900 rounds.

---

## Smart Contract Deployment

Deploy your own instance of the commit-reveal contract before enabling live loot box mode. Full instructions are in [`contracts/README.md`](contracts/README.md).

Summary:

```bash
# Pre-compiled TEAL artifacts are included -- you only need to recompile if
# you modify the contract source.

# (Optional) Install TEALScript compiler
npm install --save-dev @algorandfoundation/tealscript

# (Optional) Recompile -- run from the contracts/ directory
cd contracts
npx tealscript lootbox-commit-reveal/contract.algo.ts lootbox-commit-reveal/artifacts --skip-algod

# Deploy using AlgoKit or goal
# createApplication requires: treasury address, crate price in microALGO
algokit deploy

# Fund the contract account for box MBR (see contracts/README.md)

# Set the app ID in .env.local
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
| Loot Box | Payment is sent to treasury (real ALGO is spent). Prize is resolved locally using server-side randomness (no smart contract interaction). Not distributed on-chain. | Atomic payment + app call group. VRF-derived randomness. Prize distributed from master wallet. | `LOOTBOX_LIVE_ENABLED=true` |

This lets you develop the UI, test wallet integration, and verify payment flows without risking real assets.

---

## Security

### Built-In Protections

- **Server-side secrets** -- `MANAGER_MNEMONIC` and `LOOTBOX_MASTER_MNEMONIC` are used only in API routes and server actions. They do not have the `NEXT_PUBLIC_` prefix, so Next.js never bundles them into client-side JavaScript.
- **Payment verification** -- The server verifies every payment on-chain via the indexer with a retry loop (handles indexer lag). Checks sender, receiver, amount, transaction type, and rejects transactions with `rekey-to` or `close-remainder-to` fields. Enforces a maximum transaction age (10 minutes for payments to accommodate crash-recovery retries, 5 minutes for reveal transactions).
- **NFT ownership verification** -- The mint endpoint confirms the user's wallet actually holds the NFT before applying trait changes.
- **Transaction replay prevention** -- Used transaction IDs are tracked in memory and rejected if resubmitted. Entries are pruned after one hour. Claimed IDs are released on all error paths so users can retry.
- **Rate limiting** -- Every API route has per-wallet or per-IP rate limiting with automatic pruning.
- **SSRF protection** -- Metadata fetching blocks requests to localhost, private IP ranges (10.x, 172.16-31.x, 192.168.x), IPv6 loopback, cloud metadata endpoints (169.254.169.254), and `.local`/`.internal`/`.localhost` hostnames.
- **Admin authentication** -- Admin access requires signing a challenge nonce with Ed25519 signature verification. The challenge transaction is validated for type (payment), zero amount, self-payment, and absence of rekey/close fields. Sessions expire after 1 hour.
- **Safe error messages** -- API routes return only pre-approved error strings to the client, preventing internal details from leaking.
- **Path traversal protection** -- Trait names are sanitized before constructing layer image URLs, stripping `../`, `/`, `\`, `:`, and null bytes.
- **Wallet separation** -- The template recommends using separate wallets for the manager (metadata authority) and the master (prize pool), limiting blast radius if a key is compromised.
- **Crash recovery** -- If the browser closes or refreshes mid-flow, the pending reveal state is persisted in `sessionStorage`. On reload the UI resumes from where the user left off (VRF wait or server reveal), so committed ALGO is not lost.
- **Loot box pause switch** -- Set `LOOTBOX_PAUSED=true` to immediately halt new commits and reveals without redeploying.
- **On-chain randomness** -- In live mode, randomness is generated entirely by the smart contract via VRF seed extraction. The server reads the ABI return value from the confirmed reveal transaction -- it never touches the VRF seed directly. There is no fallback to server-side `crypto.randomBytes` in live mode.
- **Contract-enforced payment** -- The smart contract's `commit()` method verifies the preceding payment in the atomic group (correct receiver, amount, sender). No one can commit without paying. A second commit is rejected if the sender already has an active commit box, preventing silent payment loss.
- **Atomic group verification** -- In live mode, the commit transaction group (payment + app call) is built server-side with `assignGroupID`. The reveal route verifies the on-chain reveal transaction's app ID, sender, and ABI method selector.

### Production Hardening Recommendations

- **Persistent replay protection** -- The in-memory transaction ID set resets on server restart. For production, store used transaction IDs in a database (Redis, Vercel KV, Supabase).
- **Prize locking** -- Implement a lock-distribute-confirm pattern with database persistence to handle partial failures during prize distribution.
- **Session persistence** -- Admin sessions are in-memory. Use encrypted httpOnly cookies or a session store for production.
- **Commit box cleanup** -- Commit boxes are deleted automatically when `reveal()` succeeds. For abandoned commits (user commits but never reveals), expired entries can be cleaned via `reclaim()` after 900 rounds. Consider a periodic cleanup script for high-traffic deployments.
- **Persistent rate limiting** -- The in-memory rate limiters reset on restart. Use edge middleware or a distributed rate limiter (Redis, Vercel KV) for production.
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
    lootbox/commit/route.ts         Build unsigned commit transactions
    lootbox/build-reveal/route.ts   Build unsigned reveal app call
    lootbox/reveal/route.ts         Verify on-chain reveal, resolve & distribute prize
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
    contract.algo.ts                TEALScript commit-reveal smart contract
    artifacts/                      Pre-compiled TEAL, ARC-32/ARC-56 app specs, source map
  tsconfig.json                     TEALScript compiler config (excluded from Next.js build)

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
- Persistent transaction replay protection (database-backed)
- Server-side image composition for layered PFP trait images
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
