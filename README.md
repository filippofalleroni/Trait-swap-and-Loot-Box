# Algorand TraitSwap & LootBox

An open-source template for Algorand NFT projects to add **trait swapping** (ARC-19 metadata updates) and **loot box** (commit-reveal randomness) functionality. Designed to be white-labeled and customized for any Algorand NFT collection.

Originally developed by the **MONSTRS / Famverse** team.

---

## Features

- **Trait Lab** -- Browse, preview, and apply new traits to your NFTs with on-chain ARC-19 metadata updates. Traits are composited as layered images (background, skin, body, eyes, mouth, top, companion) and the resulting image + metadata is uploaded to IPFS.
- **Loot Box** -- Commit-reveal based loot box with verifiable randomness derived from Algorand's VRF beacon. Supports tiered prizes including fungible tokens and unique NFTs.
- **Admin Panel** -- Manage prize configurations, view treasury and master wallet balances, opt the master wallet in to new assets, and inspect the prize pool inventory. Access is controlled by wallet signature authentication.
- **Wallet Integration** -- Pera, Defly, and Lute wallet support via `@txnlab/use-wallet`. Users connect their wallet to view their NFTs, swap traits, and open loot boxes.
- **White-label Ready** -- All configuration is centralized in the `config/` directory. Swap out collection addresses, trait images, prize tiers, site name, and colors to make it your own.

---

## Architecture Overview

```
+------------------+       +-------------------+       +------------------+
|                  |       |                   |       |                  |
|   User's Wallet  | <---> |   Next.js 14 App  | <---> |    Algorand      |
|  (Pera/Defly/    |       |   (Frontend +     |       |    Blockchain    |
|     Lute)        |       |                   |       |                  |
|                  |       |    API Routes)     |       |                  |
+------------------+       +-------------------+       +------------------+
                                   |                          |
                                   v                          v
                           +---------------+         +------------------+
                           |   Pinata /    |         |  Commit-Reveal   |
                           |   IPFS        |         |  Smart Contract  |
                           +---------------+         +------------------+
```

### Key Components

- **Next.js 14 App Router** -- Serves both the frontend UI and server-side API routes. All sensitive operations (signing with manager wallet, prize distribution) happen in API routes on the server.
- **Algorand Blockchain** -- All transactions (trait swap payments, loot box commits/reveals, prize distributions) are recorded on Algorand.
- **ARC-19 Standard** -- Enables mutable NFT metadata. The ASA's "reserve" address field encodes an IPFS CID. Updating the reserve address (via the manager wallet) effectively changes the NFT's metadata and image without creating a new asset.
- **IPFS via Pinata** -- New metadata JSON and composited trait images are uploaded to IPFS through Pinata's pinning API, ensuring decentralized and permanent storage.
- **Commit-Reveal Smart Contract** -- An Algorand TypeScript (TEALScript) contract that implements a commit-reveal pattern using a PCG32 random number generator (based on [lib-pcg-avm](https://github.com/CiottiGiorgio/lib-pcg-avm) by Giorgio Ciotti) seeded by Algorand's VRF beacon. Users commit at a specific round, then reveal after 8+ rounds to derive verifiable random output.
- **Manager Wallet (server-side)** -- The wallet set as the "manager" address on your NFT ASAs. Only this wallet can update the reserve address (ARC-19 metadata pointer). Its mnemonic is stored server-side and never exposed to the client.
- **Treasury Wallet** -- Receives fees from trait swaps and loot box purchases.
- **Master Loot Box Wallet (server-side)** -- Holds the prize pool (tokens and NFTs) and distributes prizes to winners. Its mnemonic is stored server-side and never exposed to the client.

---

## Quick Start

### Prerequisites

- **Node.js 18+** (recommended: Node.js 20)
- **npm** (comes with Node.js)
- An Algorand wallet for testing -- **Pera** (mobile or web), **Defly**, or **Lute**
- (Optional) An Algorand testnet account funded via the [Algorand faucet](https://bank.testnet.algorand.network/)

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/filippofalleroni/Trait-swap-and-Loot-Box.git
cd Trait-swap-and-Loot-Box

# 2. Install dependencies
npm install

# 3. Copy the example environment file
cp .env.example .env.local

# 4. Configure environment variables (see "Environment Variables" section below)
#    At minimum, set MANAGER_MNEMONIC, PINATA_JWT, and TREASURY_ADDRESS for trait swapping.
#    For loot box functionality, also set LOOTBOX_MASTER_MNEMONIC and LOOTBOX_CONTRACT_APP_ID.

# 5. Start the development server
npm run dev

# 6. Open in your browser
open http://localhost:3000
```

The app starts in **preview mode** by default -- trait swaps and loot box openings are simulated without making real on-chain changes. This lets you develop and test the UI safely.

---

## Environment Variables

Copy `.env.example` to `.env.local` and configure each variable:

### Algorand Node

| Variable | Description | Default |
|---|---|---|
| `NEXT_PUBLIC_ALGOD_URL` | Algorand node API URL. Use Nodely's free endpoints. For **mainnet**: `https://mainnet-api.4160.nodely.dev`. For **testnet** development: `https://testnet-api.4160.nodely.dev` | `https://mainnet-api.4160.nodely.dev` |

### Trait Swapping

| Variable | Description | Default |
|---|---|---|
| `MANAGER_MNEMONIC` | The 25-word mnemonic for your collection's **manager wallet**. This wallet **must** be set as the manager address on every NFT ASA in your collection. If this wallet is not the actual manager, asset config transactions will fail and trait swaps will not work. Generate a new account using `goal account new` or any Algorand wallet, then set it as the manager on your ASAs. | *(required)* |
| `PINATA_JWT` | JWT token for Pinata's IPFS pinning API. Go to [pinata.cloud](https://app.pinata.cloud), create a free account, navigate to **API Keys**, and generate a new key. Copy the JWT (not the API key or secret). | *(required)* |
| `ARC19_LIVE_UPDATES_ENABLED` | Set to `"true"` to enable real on-chain ARC-19 metadata updates. When `"false"`, the trait swap endpoint runs in **preview mode** -- it simulates the process but does not submit any transactions or upload to IPFS. **Only set to `"true"` when you are ready for production.** | `false` |
| `TREASURY_ADDRESS` | The Algorand address that receives trait swap fees. **Required** -- the app will throw an error at runtime if this is not set. | *(required)* |

### Loot Box

| Variable | Description | Default |
|---|---|---|
| `LOOTBOX_MASTER_MNEMONIC` | The 25-word mnemonic for the prize distribution wallet. This wallet holds all prize tokens and NFTs and sends them to winners. **Use a separate wallet from the manager** -- this keeps concerns separated and limits blast radius if one key is compromised. The manager wallet should only have authority over ASA metadata; the master wallet should only hold prize inventory. | *(required for loot box)* |
| `LOOTBOX_CONTRACT_APP_ID` | The application ID of your deployed commit-reveal smart contract. See the "Deploying the Smart Contract" section below. Set to `0` or leave empty to use preview mode. | `0` |
| `LOOTBOX_LIVE_ENABLED` | Set to `"true"` to enable real prize distribution. When `"false"`, the loot box runs in **preview mode** -- it builds a simple payment transaction to treasury instead of a grouped payment + app call. | `false` |

### Admin & Access Control

| Variable | Description | Default |
|---|---|---|
| `ADMIN_WALLETS` | Comma-separated list of Algorand wallet addresses that can access the admin panel. Example: `ADDR1,ADDR2,ADDR3`. You can also hardcode addresses directly in `config/admin.ts`. | *(empty)* |

### Optional

| Variable | Description | Default |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob storage token for persisting prize configuration across deployments. If not set, prize config is saved to `/tmp/lootbox-prizes.json` (which resets on each deploy). Only needed for Vercel deployments where you want persistent prize config without redeploying. | *(empty)* |

---

## Customization Guide

### Setting Up Your Collection

Edit `config/collection.ts` to match your NFT collection:

```typescript
// The creator address of your NFT collection's ASAs.
// When a user connects their wallet, the app queries the Algorand indexer
// for all ASAs created by this address to find NFTs belonging to your collection.
export const COLLECTION_CREATOR_ADDRESS = "YOUR_COLLECTION_CREATOR_ADDRESS";

// The unit name prefix for your ASAs (e.g., "MONSTR", "COOL", "APE").
// Used for display filtering and identification.
export const COLLECTION_UNIT_PREFIX = "NFT";

// Total number of NFTs in your collection (display only).
export const COLLECTION_SIZE = 5000;
```

### Configuring Traits

The trait system uses layered PNG images composited in a fixed order. Each NFT is rendered by stacking transparent PNGs from bottom to top.

**Layer order** (defined in `lib/nft-layering.ts`):

1. `BACKGROUND` (bottom layer)
2. `SKIN`
3. `BODY`
4. `EYES`
5. `MOUTH`
6. `TOP`
7. `COMPANION` (top layer)

**Adding trait images:**

Place your trait PNG files in the `public/traits/` directory following this structure:

```
public/
  traits/
    BACKGROUND/
      Sunset.png
      Ocean-Blue.png
      Cosmic-Nebula.png
    SKIN/
      Default.png
      Gold.png
    BODY/
      Default.png
      Hoodie.png
    EYES/
      Default.png
      Laser.png
    MOUTH/
      Default.png
      Smile.png
    TOP/
      Example-Hat.png
      Golden-Crown.png
      Baseball-Cap.png
    COMPANION/
      Dragon.png
      Cat.png
```

All trait images should be the same dimensions (square, e.g., 1000x1000px) with transparent backgrounds so they composite correctly.

**Configuring trait definitions:**

Edit `config/mock-data.ts` to define your available traits:

```typescript
export const mockTraits: Trait[] = [
  {
    id: "trait-top-1",          // Unique identifier
    name: "Example Hat",         // Display name
    category: "TOP",             // Must match a layer category
    rarity: "Common",           // Common | Rare | Epic | Legendary
    priceAlgo: 5,               // Cost in ALGO to apply this trait
    imageUrl: "/traits/TOP/Example-Hat.png",  // Path to the PNG
    description: "A simple hat for your NFT.",
  },
  // ... add more traits
];
```

For production, you should replace the mock data system with a real trait registry backed by ASA IDs, allowing you to track trait ownership and availability on-chain.

**Pricing:**

- Trait swap price is set per-trait in the `priceAlgo` field
- Trait removal fee is configured in `config/fees.ts` (default: 5 ALGO)

### Configuring Loot Box Prizes

Edit `config/lootbox.ts` to define your prize tiers:

```typescript
export const lootboxConfig = {
  cratePrice: 10,                    // Price in ALGO to open one loot box
  cratePriceMicroAlgo: 10_000_000,   // Same price in microALGO
  commitDelayRounds: 8,              // Rounds to wait between commit and reveal
  randomnessBeaconAppId: 947461882,  // Algorand randomness beacon app ID

  prizes: [
    {
      id: "token-500",
      name: "500 Tokens",
      type: "token",      // "token" = fungible (infinite supply from master wallet)
      assetId: 123456789,  // Replace with your token's ASA ID
      amount: 500,          // Amount of tokens to send
      weight: 30,           // Higher weight = more common
      rarity: "common",    // common | uncommon | rare | epic | legendary
      color: "#4ade80",     // Color for UI animations
    },
    {
      id: "nft-rare-1",
      name: "Rare NFT #42",
      type: "nft",         // "nft" = unique (removed from pool when won)
      assetId: 987654321,
      amount: 1,
      weight: 2,
      rarity: "legendary",
      color: "#fbbf24",
    },
  ],
};
```

**How weights work:** The probability of winning a prize is `weight / totalWeight`. For example, if you have prizes with weights 30, 20, 10, 5, and 2, the total weight is 67. The first prize has a 30/67 (44.8%) chance of being selected.

**Token vs NFT prizes:**
- `type: "token"` -- Fungible token prizes (like your project token). These are **permanent** entries -- the master wallet can distribute them repeatedly as long as it holds a sufficient balance.
- `type: "nft"` -- Unique prizes (individual NFTs or limited tokens). These should be **removed from the prize list** after being won. Use the admin panel to manage this.

**Master wallet setup:**
1. The master wallet must be **opted in** to every ASA it will distribute as prizes
2. The master wallet must **hold** sufficient balances of all prize tokens/NFTs
3. Use the admin panel to opt the master wallet in to new assets, or do it manually via any Algorand wallet

You can also manage prizes dynamically through the admin panel at `/admin` without redeploying.

### Deploying the Smart Contract

The commit-reveal smart contract is located in `contracts/lootbox-commit-reveal/contract.algo.ts`. It is written in TEALScript.

**How the contract works:**

1. **Commit** -- The user calls the `commit()` method, which records the current Algorand round number in a box keyed by the sender's address.
2. **Wait** -- The user must wait at least 8 rounds (~12-16 seconds) for the VRF seed to be finalized.
3. **Reveal** -- The user calls `reveal()`. The contract reads the VRF seed from the block at `commitRound + 1`, runs it through a PCG32 pseudo-random number generator, and returns the random value. The commit record is then deleted.

This pattern ensures the randomness could not have been known at commit time, making it verifiable and tamper-resistant.

**To deploy:**

```bash
# Install AlgoKit if you haven't already
pipx install algokit

# Navigate to the contract directory
cd contracts/lootbox-commit-reveal

# Compile the contract
algokit compile contract.algo.ts

# Deploy to testnet (or localnet)
algokit deploy --network testnet

# Note the App ID from the deployment output
# Set it in your .env.local:
# LOOTBOX_CONTRACT_APP_ID=<your-app-id>
```

You may need to modify the contract to suit your specific requirements. See the [AlgoKit documentation](https://developer.algorand.org/docs/get-started/algokit/) for more details on compilation and deployment.

### Customizing the UI

**Site name and description:**

Edit `config/site.ts`:

```typescript
export const siteConfig = {
  name: "Your Project Name",
  description: "Your project description",
};

export const SITE_NAME = siteConfig.name;
export const SITE_DESCRIPTION = siteConfig.description;
```

**Navigation:**

Edit the `NAV_LINKS` array in `components/header.tsx` to add, remove, or rename navigation items:

```typescript
const NAV_LINKS = [
  { href: "/trait-lab", label: "Trait Lab" },
  { href: "/lootbox", label: "Loot Box" },
  { href: "/admin", label: "Admin" },
];
```

**Colors and theme:**

- The app uses a dark zinc color scheme by default (defined in `app/globals.css` and component classes)
- All styling uses Tailwind CSS utility classes -- modify them directly in the component files
- Extend or override the theme in `tailwind.config.ts`:

```typescript
const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          500: "#your-color",
        },
      },
    },
  },
  plugins: [],
};
```

- Rarity colors for loot box animations are configured in `config/lootbox.ts` via the `RARITY_COLORS` map
- The app uses the Inter font from Google Fonts (loaded in `app/layout.tsx`)
- No external images are required -- all UI elements are text and CSS-based

---

## How It Works (Technical Deep Dive)

### Trait Swapping Flow

```
User                     Frontend              API Server              Algorand / IPFS
 |                          |                       |                        |
 |-- Connect Wallet ------->|                       |                        |
 |                          |-- Fetch owned NFTs -->|                        |
 |                          |                       |-- Query indexer ------>|
 |                          |                       |<-- ASAs by creator ----|
 |                          |                       |-- Fetch ARC-19 meta ->|
 |                          |                       |<-- IPFS metadata ------|
 |                          |<-- NFT list + traits -|                        |
 |-- Select trait --------->|                       |                        |
 |                          |-- Preview (client) -->|                        |
 |-- Click "Apply" -------->|                       |                        |
 |                          |-- Request payment tx->|                        |
 |                          |<-- Unsigned tx -------|                        |
 |<-- Sign in wallet -------|                       |                        |
 |-- Signed tx ------------>|-- Submit signed tx -->|                        |
 |                          |                       |-- Submit payment ----->|
 |                          |                       |<-- Confirmed ----------|
 |                          |                       |-- Compose new image ---|
 |                          |                       |-- Upload to IPFS ----->|
 |                          |                       |<-- New CID ------------|
 |                          |                       |-- Compute reserve addr |
 |                          |                       |-- Sign + submit ------>|
 |                          |                       |   asset config txn     |
 |                          |                       |<-- Confirmed ----------|
 |                          |<-- Success -----------|                        |
 |<-- Updated NFT ----------|                       |                        |
```

Step by step:

1. **User connects wallet** -- The app uses `@txnlab/use-wallet` with Pera, Defly, and Lute wallets configured in `contexts/wallet-context.tsx`.
2. **Fetch owned NFTs** -- The server queries the Algorand indexer for all ASAs created by `COLLECTION_CREATOR_ADDRESS` that exist in the user's wallet.
3. **Read current metadata** -- For each NFT, the ARC-19 reserve address is decoded to an IPFS CID, and the metadata JSON is fetched. This reveals the current trait layers.
4. **Preview changes** -- The `NftLayeredImage` component composites trait PNG layers client-side in the correct `LAYER_ORDER`, showing the user what their NFT will look like with the new trait.
5. **Build payment transaction** -- The server creates an unsigned payment transaction from the user to the treasury address for the trait price.
6. **User signs** -- The unsigned transaction is sent to the connected wallet for signing.
7. **Submit payment** -- The signed payment transaction is submitted to Algorand.
8. **Server-side processing** -- After verifying the payment, the server:
   - Composites the new NFT image by layering the trait PNGs in order
   - Uploads the new image and metadata JSON to IPFS via Pinata
   - Computes the ARC-19 reserve address by encoding the new IPFS CID's multihash digest as an Algorand address (see `lib/arc19-update.ts`)
   - Signs an asset config transaction using the manager wallet to update the ASA's reserve address
   - Submits the asset config transaction to Algorand
9. **NFT updated** -- The NFT's on-chain metadata pointer now references the new IPFS content. Any wallet or explorer that supports ARC-19 will display the updated image and traits.

### Loot Box Flow

```
User                     Frontend              API Server              Smart Contract
 |                          |                       |                        |
 |-- Click "Open Box" ----->|                       |                        |
 |                          |-- Check asset opt-ins |                        |
 |                          |-- POST /commit ------>|                        |
 |                          |                       |-- Build payment tx ----|
 |                          |                       |-- Build app call tx ---|
 |                          |                       |-- Group transactions --|
 |                          |<-- Unsigned group ----|                        |
 |<-- Sign in wallet -------|                       |                        |
 |-- Signed txns ---------->|-- Submit to chain --->|                        |
 |                          |                       |              commit() called
 |                          |                       |              round recorded
 |                          |-- Wait 8+ rounds ---->|                        |
 |                          |-- POST /reveal ------>|                        |
 |                          |                       |              reveal() called
 |                          |                       |              VRF seed read
 |                          |                       |              random returned
 |                          |                       |-- Select prize --------|
 |                          |                       |-- Send prize from -----|
 |                          |                       |   master wallet        |
 |                          |<-- Prize result ------|                        |
 |<-- Prize animation ------|                       |                        |
```

Step by step:

1. **User connects wallet** and navigates to the loot box page.
2. **Prize list loads** from the server (configured in `config/lootbox.ts` or the admin panel).
3. **User clicks "Open Loot Box"**.
4. **Opt-in check** -- The client checks whether the user is opted in to all possible prize ASAs. If not, opt-in transactions are built and included in the signing batch.
5. **Commit phase** -- The server builds a transaction group containing:
   - A payment transaction (user pays `cratePrice` ALGO to treasury)
   - An application call to the commit-reveal contract's `commit()` method
   - These are grouped with `algosdk.assignGroupID()` so they are atomic
6. **User signs** all transactions (opt-ins + grouped payment + app call) in a single wallet prompt.
7. **Transactions submitted** -- The signed group is submitted to Algorand. The smart contract records the user's commit round.
8. **Wait period** -- The client waits for at least 8 rounds to pass (~12-16 seconds).
9. **Reveal phase** -- The server calls the contract's `reveal()` method. The contract:
   - Reads the VRF seed from the block at `commitRound + 1`
   - Runs the seed through the PCG32 PRNG to produce a random value
   - Deletes the commit record
10. **Prize selection** -- The server uses `lib/lootbox-prize-resolver.ts` to select a prize using weighted random selection with the VRF-derived randomness.
11. **Prize distribution** -- The server uses `lib/lootbox-distributor.ts` to send the prize (token transfer or NFT transfer) from the master wallet to the user.
12. **Result displayed** -- The frontend shows the prize with a rarity-colored animation.

### ARC-19 Metadata Standard

ARC-19 is an Algorand standard for mutable NFT metadata that works as follows:

- Every Algorand Standard Asset (ASA) has a **reserve address** field that can be updated by the asset's **manager** address.
- ARC-19 repurposes this field: instead of storing an actual Algorand address, it encodes an **IPFS CID** (Content Identifier) as a 32-byte public key.
- Wallets and explorers that support ARC-19 decode the reserve address back into a CID, fetch the corresponding JSON metadata from IPFS, and display the NFT's image, name, and attributes.
- To update an NFT's metadata, you upload new metadata to IPFS (which gives you a new CID), compute the corresponding reserve address, and submit an asset config transaction signed by the manager wallet.

This means NFT metadata can be updated without creating a new asset -- the ASA ID stays the same, but its visual representation changes. This is what makes trait swapping possible.

The conversion logic lives in `lib/arc19-update.ts`:

```typescript
// CID -> 32-byte multihash digest -> Algorand address
const parsed = CID.parse(cidString);
const digest = parsed.multihash.digest; // 32 bytes (SHA-256)
const reserveAddress = algosdk.encodeAddress(digest);
```

---

## Deployment

### Vercel (Recommended)

1. Push your repository to GitHub.
2. Go to [vercel.com](https://vercel.com) and import the repository.
3. Add **all** environment variables in the Vercel dashboard under **Settings > Environment Variables**. Make sure server-side variables (`MANAGER_MNEMONIC`, `LOOTBOX_MASTER_MNEMONIC`, `PINATA_JWT`) are set as regular environment variables (not prefixed with `NEXT_PUBLIC_`).
4. Click **Deploy**.

The project includes a `vercel.json` with `"framework": "nextjs"` already configured.

For persistent prize configuration across redeployments, set up a `BLOB_READ_WRITE_TOKEN` with [Vercel Blob storage](https://vercel.com/docs/storage/vercel-blob).

### Self-Hosted

```bash
# Build the production bundle
npm run build

# Start the production server
npm start
```

Requirements:
- Node.js 18+
- All environment variables must be set in the shell environment or a `.env.local` file
- The server listens on port 3000 by default (configure with the `PORT` environment variable)

---

## Production Considerations

This template is designed for rapid prototyping and development. Before deploying to production with real assets, address the following:

### Transaction Replay Protection

This template does not prevent the same payment transaction ID from being reused for lootbox reveals or trait mints. In production, store used transaction IDs in a persistent database (e.g., Vercel KV, Redis, or Supabase) and reject any transaction ID that has already been processed. The Monstrs production version uses Vercel Blob storage for this.

### Prize Locking & Idempotency

If prize distribution fails mid-way (e.g., a network timeout occurs after a prize is resolved but before the ASA transfer confirms), there is no recovery mechanism. In production, implement a lock-distribute-confirm pattern: lock the selected prize in a database, attempt distribution, and mark it as complete only after on-chain confirmation. This prevents prize loss and enables retry logic for failed transfers.

### Session Persistence

Admin sessions are stored in-memory and will be lost on server restart or redeployment. For production, use encrypted httpOnly cookies with HMAC signing, or a session store backed by Redis or Vercel KV.

### Payment Verification

While basic payment verification is included (receiver address, amount, sender), production deployments should additionally verify group transaction membership when using the commit-reveal smart contract. Confirm that the payment and app call are in the same atomic group, and validate the app call arguments to ensure they match the expected commit or reveal parameters.

### Rate Limiting

API routes do not include rate limiting. Add rate limiting middleware (e.g., using Vercel's edge middleware or a library like `rate-limiter-flexible`) to prevent abuse of the commit, reveal, and mint endpoints.

### Image Composition

This template updates NFT metadata JSON only. If your NFTs use layered trait images (like PFP collections), you will need to add server-side image composition (e.g., using `sharp` or `canvas`) to generate the final composed image before uploading to IPFS. The `NftLayeredImage` component handles client-side preview, but the server must produce the canonical composited image.

### Database for Trait Registry

The template uses a static mock trait registry defined in `config/mock-data.ts`. In production, use a database (e.g., Supabase, PlanetScale, or Vercel Postgres) to store your trait catalog, prices, supply limits, and applied-trait counts so they can be managed dynamically without redeployment.

---

## Security Considerations

- **Never expose mnemonics to the client.** `MANAGER_MNEMONIC` and `LOOTBOX_MASTER_MNEMONIC` must only be used in server-side code (API routes and server actions). They do **not** have the `NEXT_PUBLIC_` prefix, which means Next.js will not bundle them into client-side JavaScript.
- **Admin authentication uses wallet signatures**, not passwords. Admins prove wallet ownership by signing a challenge nonce in a self-payment transaction (see `app/actions/admin.ts`). The transaction is never submitted to the chain.
- **Payment verification is server-side.** The server verifies that trait swap and loot box payments have been confirmed on-chain before performing any privileged actions (metadata updates, prize distributions).
- **Separate your wallets.** Use different wallets for the manager (metadata updates) and the loot box master (prize distribution). This limits damage if a key is compromised.
- **Rate limiting is not included.** For production deployments, add rate limiting to API routes (e.g., using Vercel's built-in rate limiting or a middleware like `express-rate-limit`) to prevent abuse.
- **Audit the smart contract.** The included commit-reveal contract is a reference implementation. Have it reviewed before deploying with real funds.

---

## Project Structure

```
algorand-traitswap-lootbox/
|
|-- app/                              # Next.js 14 App Router
|   |-- layout.tsx                    # Root layout (Inter font, providers, header)
|   |-- page.tsx                      # Home page with feature cards
|   |-- globals.css                   # Global styles (Tailwind base + dark theme)
|   |-- admin/
|   |   +-- page.tsx                  # Admin panel page (gated by AdminGate)
|   |-- actions/
|   |   +-- admin.ts                  # Server actions: auth, prize CRUD, opt-in, revenue
|   |-- api/
|   |   |-- lootbox/
|   |   |   |-- commit/
|   |   |   |   +-- route.ts          # POST: build unsigned commit transactions
|   |   |   |-- reveal/               # POST: verify payment, resolve & distribute prize
|   |   |   |-- prizes/               # GET: return prize list with calculated chances
|   |   |   +-- buyer-balance/        # GET: master wallet ALGO balance
|   |   |-- trait-lab/
|   |   |   |-- mint/                 # POST: verify payment, update ARC-19 metadata
|   |   |   +-- payment-tx/           # POST: build unsigned payment transaction
|   |   |-- owned-nfts/               # GET: query wallet's collection NFTs
|   |   +-- trait-counts/             # GET: trait popularity counts
|   |-- lootbox/
|   |   |-- page.tsx                  # Loot box page with commit-reveal UI
|   |   +-- admin/
|   |       +-- page.tsx              # Secondary loot box admin route
|   +-- trait-lab/
|       +-- page.tsx                  # Trait Lab page with swap UI
|
|-- components/
|   |-- admin-gate.tsx                # Restricts content to admin wallets
|   |-- connect-wallet-button.tsx     # Wallet connect dropdown/modal (Pera, Defly, Lute)
|   |-- footer.tsx                    # Simple footer
|   |-- header.tsx                    # Sticky header with nav links + wallet button
|   |-- lootbox-admin.tsx             # Admin panel: prizes, revenue, opt-ins, inventory
|   |-- lootbox-studio.tsx            # Loot box UI: commit-reveal flow + prize display
|   |-- nft-layered-image.tsx         # Composites NFT trait layers as stacked images
|   |-- providers.tsx                 # Wraps children with Wallet + Toast providers
|   |-- trait-swapper.tsx             # Trait Lab UI: NFT selector, trait grid, swap flow
|   +-- wallet-gate.tsx              # Wallet gate with loading states + connect modal
|
|-- config/
|   |-- admin.ts                      # Admin wallet addresses (env or hardcoded)
|   |-- collection.ts                 # Collection creator address + unit prefix
|   |-- fees.ts                       # Trait removal fee + tx fee estimates
|   |-- lootbox.ts                    # Prize tiers, weights, crate price, rarity colors
|   |-- mock-data.ts                  # Example traits + NFTs for development
|   +-- site.ts                       # Site name + description
|
|-- contexts/
|   |-- toast-context.tsx             # Toast notification system (auto-dismiss)
|   +-- wallet-context.tsx            # Wallet provider (Pera/Defly/Lute) + useWallet hook
|
|-- contracts/
|   |-- README.md                     # Contract deployment instructions
|   +-- lootbox-commit-reveal/
|       +-- contract.algo.ts          # TEALScript commit-reveal smart contract
|
|-- lib/
|   |-- algorand.ts                   # Algod + Indexer client initialization
|   |-- arc19-update.ts               # ARC-19 CID-to-address + reserve address updater
|   |-- format.ts                     # ALGO formatting + address shortening utilities
|   |-- lootbox-distributor.ts        # Sends prize tokens/NFTs from master wallet
|   |-- lootbox-master-wallet.ts      # Loads master wallet from mnemonic env var
|   |-- lootbox-prize-resolver.ts     # Weighted random prize selection
|   |-- manager-signer.ts            # Loads manager wallet from mnemonic env var
|   |-- nft-layering.ts               # Layer order, category validation, image URLs
|   |-- pinata.ts                     # IPFS upload via Pinata API
|   |-- treasury.ts                   # Treasury address getter
|   +-- types.ts                      # TypeScript types (Trait, NFT, Prize, etc.)
|
|-- .env.example                      # Template for environment variables
|-- .gitignore                        # Ignores node_modules, .next, .env.local, etc.
|-- next.config.mjs                   # IPFS remote image pattern allowlist
|-- package.json                      # Dependencies and scripts
|-- postcss.config.js                 # PostCSS config for Tailwind
|-- tailwind.config.ts                # Tailwind CSS configuration
|-- tsconfig.json                     # TypeScript compiler options
+-- vercel.json                       # Vercel framework hint
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

Contributions are welcome! Here is how to get started:

1. **Fork** the repository.
2. **Create a branch** for your feature or fix: `git checkout -b feature/my-feature`.
3. **Make your changes** and test them locally.
4. **Commit** with a clear message describing what you changed and why.
5. **Push** to your fork and open a **Pull Request** against `main`.

Please keep PRs focused on a single change. If you are adding a new feature, include a brief description of how to test it.

### Ideas for Contributions

- Add unit tests for prize resolution and ARC-19 address computation
- Implement rate limiting middleware for API routes
- Add transaction replay protection (see Production Considerations)
- Add support for ARC-69 metadata in addition to ARC-19
- Add server-side image composition for layered PFP collections
- Create a trait registry backed by a database or on-chain ASA ownership
- Add support for additional wallets (Exodus, WalletConnect v2)

---

## License

This project is released under the [MIT License](LICENSE).

---

## Credits

- Originally developed by the **MONSTRS / Famverse** team
- PCG32 random number generator based on [lib-pcg-avm](https://github.com/CiottiGiorgio/lib-pcg-avm) by Giorgio Ciotti
- Commit-reveal pattern uses the [Algorand Randomness Beacon](https://developer.algorand.org/docs/get-details/randomness-beacon/)
- Built with [Next.js](https://nextjs.org/), [Algorand SDK](https://github.com/algorand/js-algorand-sdk), [TailwindCSS](https://tailwindcss.com/), and [@txnlab/use-wallet](https://github.com/TxnLab/use-wallet)
- IPFS pinning by [Pinata](https://pinata.cloud)
- Free Algorand node access by [Nodely](https://nodely.io)
