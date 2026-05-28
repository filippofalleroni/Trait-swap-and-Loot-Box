import "server-only";
import { NextRequest, NextResponse } from "next/server";
import algosdk from "algosdk";
import { INDEXER_BASE_URL, resolveArc19Url } from "@/lib/algorand";
import { getTreasuryAddress } from "@/lib/treasury";
import { getManagerAccount } from "@/lib/manager-signer";
import { isPinataConfigured, uploadJsonToIpfs, uploadBufferToIpfs } from "@/lib/pinata";
import { computeArc19ReserveAddress, updateArc19Metadata } from "@/lib/arc19-update";
import { composeNftImage } from "@/lib/nft-compose";
import { mockTraits } from "@/config/mock-data";
import { feeConfig } from "@/config/fees";
import type { NftMetadata, OfficialTraitCategory } from "@/lib/types";
import { TRAIT_ID_REGEX } from "@/lib/types";
import { LAYER_ORDER, isOfficialTraitCategory } from "@/lib/nft-layering";
import { isBlockedHostname } from "@/lib/security";

const PAYMENT_NOTE_PREFIX = "traitswap:";

/**
 * Allow this route up to 60 seconds for indexer retries + IPFS uploads + on-chain tx.
 * On Vercel, this requires a Pro plan for serverless functions > 10 s.
 */
export const maxDuration = 60;

const ALGO_TXID_REGEX = /^[A-Z2-7]{52}$/;

/* ------------------------------------------------------------------ */
/*  Rate limiting                                                      */
/* ------------------------------------------------------------------ */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

const ipRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const IP_RATE_LIMIT_MAX = 20;

function pruneRateLimitMap() {
  const now = Date.now();
  rateLimitMap.forEach((entry, key) => {
    if (now >= entry.resetAt) rateLimitMap.delete(key);
  });
  ipRateLimitMap.forEach((entry, key) => {
    if (now >= entry.resetAt) ipRateLimitMap.delete(key);
  });
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  if (rateLimitMap.size > 1000) pruneRateLimitMap();
  const entry = rateLimitMap.get(key);
  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function isIpRateLimited(ip: string): boolean {
  const now = Date.now();
  if (ipRateLimitMap.size > 1000) pruneRateLimitMap();
  const entry = ipRateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    ipRateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > IP_RATE_LIMIT_MAX;
}

function getClientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

// NOTE: In-memory -- resets on serverless cold start. Use Redis/KV for production.
const usedMintTxIds = new Set<string>();
const usedMintTxTimestamps = new Map<string, number>();
const MAX_USED_TX_AGE_MS = 1000 * 60 * 60;

/* ------------------------------------------------------------------ */
/*  Concurrent update guard (per asset ID, single instance only)       */
/* ------------------------------------------------------------------ */
const activeUpdates = new Set<number>();

function pruneUsedMintTxIds() {
  const now = Date.now();
  usedMintTxTimestamps.forEach((ts, txId) => {
    if (now - ts > MAX_USED_TX_AGE_MS) {
      usedMintTxIds.delete(txId);
      usedMintTxTimestamps.delete(txId);
    }
  });
}

export async function POST(request: NextRequest) {
  let claimedTxId: string | null = null;
  let paymentVerified = false;

  try {
    if (!isPinataConfigured()) {
      return NextResponse.json(
        { error: "IPFS upload is not configured. Set the PINATA_JWT environment variable." },
        { status: 501 }
      );
    }

    // IP-based rate limit (harder to spoof than wallet address)
    const clientIp = getClientIp(request);
    if (isIpRateLimited(clientIp)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { nftAssetId, newTraitId, walletAddress, paymentTxId } = body as {
      nftAssetId?: number;
      newTraitId?: string;
      walletAddress?: string;
      paymentTxId?: string;
    };

    if (!nftAssetId || !newTraitId || !walletAddress || !paymentTxId) {
      return NextResponse.json(
        { error: "Missing required fields: nftAssetId, newTraitId, walletAddress, paymentTxId" },
        { status: 400 }
      );
    }

    if (!algosdk.isValidAddress(walletAddress)) {
      return NextResponse.json(
        { error: "Invalid wallet address." },
        { status: 400 }
      );
    }

    if (isRateLimited(walletAddress)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    if (
      typeof nftAssetId !== "number" ||
      !Number.isInteger(nftAssetId) ||
      nftAssetId <= 0 ||
      nftAssetId > Number.MAX_SAFE_INTEGER
    ) {
      return NextResponse.json(
        { error: "Invalid asset ID." },
        { status: 400 }
      );
    }

    if (!ALGO_TXID_REGEX.test(paymentTxId)) {
      return NextResponse.json(
        { error: "Invalid transaction ID format." },
        { status: 400 }
      );
    }

    pruneUsedMintTxIds();
    if (usedMintTxIds.has(paymentTxId)) {
      return NextResponse.json(
        { error: "This transaction has already been used." },
        { status: 409 }
      );
    }
    usedMintTxIds.add(paymentTxId);
    usedMintTxTimestamps.set(paymentTxId, Date.now());
    claimedTxId = paymentTxId;

    if (!TRAIT_ID_REGEX.test(newTraitId)) {
      usedMintTxIds.delete(paymentTxId);
      usedMintTxTimestamps.delete(paymentTxId);
      return NextResponse.json(
        { error: "Invalid trait ID format." },
        { status: 400 }
      );
    }

    const isRemoval = newTraitId.startsWith("remove-");
    const removalCategory = isRemoval
      ? newTraitId.replace("remove-", "").toUpperCase()
      : null;

    let trait = null;
    if (!isRemoval) {
      trait = mockTraits.find((t) => t.id === newTraitId);
      if (!trait) {
        usedMintTxIds.delete(paymentTxId);
        usedMintTxTimestamps.delete(paymentTxId);
        return NextResponse.json(
          { error: "Trait not found." },
          { status: 404 }
        );
      }
    }

    const expectedAmountAlgo = isRemoval
      ? feeConfig.removalFeeAlgo
      : trait?.priceAlgo;

    if (expectedAmountAlgo === undefined || expectedAmountAlgo <= 0) {
      usedMintTxIds.delete(paymentTxId);
      usedMintTxTimestamps.delete(paymentTxId);
      return NextResponse.json(
        { error: "Invalid price configuration for this trait." },
        { status: 500 }
      );
    }

    const paymentValid = await verifyPayment({
      txId: paymentTxId,
      expectedSender: walletAddress,
      expectedRecipient: getTreasuryAddress(),
      expectedAmountAlgo,
    });

    if (!paymentValid.ok) {
      usedMintTxIds.delete(paymentTxId);
      usedMintTxTimestamps.delete(paymentTxId);
      console.error("[trait-lab/mint] Payment verification failed:", paymentValid.reason);
      return NextResponse.json(
        { error: "Payment verification failed." },
        { status: 400 }
      );
    }

    paymentVerified = true;

    const ownershipValid = await verifyOwnership({
      assetId: nftAssetId,
      walletAddress,
    });

    if (!ownershipValid) {
      return NextResponse.json(
        { error: "Wallet does not own this NFT" },
        { status: 403 }
      );
    }

    const category: OfficialTraitCategory | null = isRemoval
      ? (removalCategory && isOfficialTraitCategory(removalCategory)
          ? removalCategory
          : null)
      : trait && isOfficialTraitCategory(trait.category)
        ? (trait.category as OfficialTraitCategory)
        : null;

    if (!category) {
      return NextResponse.json(
        { error: "Invalid trait category" },
        { status: 400 }
      );
    }

    const isLive = process.env.ARC19_LIVE_UPDATES_ENABLED === "true";

    if (isLive) {
      const creatorAddr = process.env.COLLECTION_CREATOR_ADDRESS?.trim();
      if (!creatorAddr || creatorAddr === "YOUR_COLLECTION_CREATOR_ADDRESS") {
        console.error("[trait-lab/mint] ARC19_LIVE_UPDATES_ENABLED is true but COLLECTION_CREATOR_ADDRESS is not configured.");
        return NextResponse.json(
          { error: "Server configuration error. Please contact the administrator." },
          { status: 500 }
        );
      }
    }

    if (!isLive) {
      return NextResponse.json({
        status: "prepared" as const,
        note: isRemoval
          ? `[Preview] Trait removal from category ${category} prepared for NFT ${nftAssetId}. Enable ARC19_LIVE_UPDATES_ENABLED to apply on-chain.`
          : `[Preview] Trait "${trait!.name}" (${category}) prepared for NFT ${nftAssetId}. Enable ARC19_LIVE_UPDATES_ENABLED to apply on-chain.`,
      });
    }

    if (activeUpdates.has(nftAssetId)) {
      return NextResponse.json(
        { error: "This NFT is already being updated. Please wait and try again." },
        { status: 409 }
      );
    }
    activeUpdates.add(nftAssetId);

    try {
      const currentMetadata = await fetchCurrentMetadata(nftAssetId);

      if (!currentMetadata) {
        return NextResponse.json(
          { error: "Could not load NFT metadata. Please try again." },
          { status: 503 }
        );
      }

      const updatedProperties = {
        ...(currentMetadata.properties ?? {}),
      };

      if (isRemoval) {
        delete updatedProperties[category];
      } else {
        updatedProperties[category] = trait!.name;
      }

      // Compose a new layered image from the updated properties
      const layerMap = {} as Partial<Record<OfficialTraitCategory, string>>;
      for (const cat of LAYER_ORDER) {
        const val = updatedProperties[cat];
        if (val && typeof val === "string") {
          layerMap[cat] = val;
        }
      }
      const { buffer: imageBuffer } = await composeNftImage(layerMap, LAYER_ORDER);
      const imageCid = await uploadBufferToIpfs(imageBuffer, `nft-${nftAssetId}.png`);

      const newMetadata: NftMetadata = {
        name: currentMetadata.name ?? `NFT #${nftAssetId}`,
        description:
          currentMetadata.description ?? "An NFT from this collection.",
        image: `ipfs://${imageCid}`,
        image_mimetype: "image/png",
        properties: updatedProperties,
        external_url: currentMetadata.external_url,
      };

      const newCid = await uploadJsonToIpfs(newMetadata as unknown as Record<string, unknown>);
      const newReserveAddress = computeArc19ReserveAddress(newCid);

      const managerAccount = getManagerAccount();
      const updateTxId = await updateArc19Metadata({
        assetId: nftAssetId,
        newReserveAddress,
        managerAccount,
      });

      console.log(
        `[trait-lab/mint] OK wallet=${walletAddress} asset=${nftAssetId} trait=${newTraitId} payTx=${paymentTxId} updateTx=${updateTxId ?? "N/A"}`
      );

      return NextResponse.json({
        status: "submitted" as const,
        note: isRemoval
          ? `Trait removed from category ${category} on NFT ${nftAssetId}. Update txId: ${updateTxId ?? "N/A"}`
          : `Trait "${trait!.name}" applied to NFT ${nftAssetId}. Update txId: ${updateTxId ?? "N/A"}`,
      });
    } finally {
      activeUpdates.delete(nftAssetId);
    }
  } catch (err) {
    // Only release the txId if payment was NOT yet verified on-chain.
    // Once verified, the payment is consumed — keeping it claimed prevents
    // the same on-chain payment from being reused with different parameters.
    if (claimedTxId && !paymentVerified) {
      usedMintTxIds.delete(claimedTxId);
      usedMintTxTimestamps.delete(claimedTxId);
    }
    console.error("[trait-lab/mint] Error:", err);
    return NextResponse.json(
      { error: "Mint process failed. Please try again." },
      { status: 500 }
    );
  }
}

/**
 * Verify a payment transaction on the indexer.
 *
 * Retries for up to ~60 s to allow the indexer time to index the confirmed tx.
 * This is critical because the client submits the payment to algod and
 * immediately calls this mint endpoint, but the indexer typically lags
 * 3-15 seconds behind algod.
 */
async function verifyPayment({
  txId,
  expectedSender,
  expectedRecipient,
  expectedAmountAlgo,
}: {
  txId: string;
  expectedSender: string;
  expectedRecipient: string;
  expectedAmountAlgo: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const MAX_ATTEMPTS = 20;
  const BASE_DELAY_MS = 3000;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const indexerUrl = `${INDEXER_BASE_URL}/v2/transactions/${txId}`;
      const indexerRes = await fetch(indexerUrl);

      if (!indexerRes.ok) {
        throw new Error("not indexed yet");
      }

      const indexerData = await indexerRes.json();
      const txn = indexerData.transaction;

      if (!txn || !txn["confirmed-round"]) {
        throw new Error("not confirmed yet");
      }

      if (txn["tx-type"] !== "pay") {
        return { ok: false, reason: "Transaction is not a payment transaction" };
      }

      // Reject transactions with rekey or close-remainder-to fields
      if (txn["rekey-to"]) {
        return { ok: false, reason: "Transaction contains a rekey field and is rejected" };
      }

      if (txn.sender !== expectedSender) {
        return { ok: false, reason: "Sender mismatch" };
      }

      const paymentDetails = txn["payment-transaction"];
      if (!paymentDetails || paymentDetails.receiver !== expectedRecipient) {
        return { ok: false, reason: "Recipient mismatch" };
      }

      if (paymentDetails["close-remainder-to"]) {
        return { ok: false, reason: "Transaction contains a close-remainder-to field and is rejected" };
      }

      // Reject payments that are part of an atomic group (e.g. lootbox commit groups).
      // Trait swap payments are standalone transactions.
      if (txn.group) {
        return { ok: false, reason: "Payment must not be part of an atomic group" };
      }

      // Verify note field contains the expected trait-swap prefix to prevent
      // cross-purpose transaction replay (e.g. reusing a lootbox payment).
      const noteB64: string = txn.note ?? "";
      const noteStr = noteB64 ? Buffer.from(noteB64, "base64").toString("utf-8") : "";
      if (!noteStr.startsWith(PAYMENT_NOTE_PREFIX)) {
        return { ok: false, reason: "Transaction note missing required trait-swap prefix" };
      }

      const expectedMicroAlgo = Math.round(expectedAmountAlgo * 1_000_000);
      if (paymentDetails.amount < expectedMicroAlgo) {
        return { ok: false, reason: "Insufficient payment amount" };
      }
      if (paymentDetails.amount > expectedMicroAlgo * 2) {
        return { ok: false, reason: "Payment amount too high — possible user error" };
      }

      const roundTime = txn["round-time"];
      if (!roundTime || roundTime <= 0) {
        return { ok: false, reason: "Transaction missing round time" };
      }
      const txAge = Math.floor(Date.now() / 1000) - roundTime;
      if (txAge < 0) {
        return { ok: false, reason: "Transaction round time is in the future" };
      }
      if (txAge > 300) {
        return { ok: false, reason: "Transaction is too old. Please submit a new payment" };
      }

      return { ok: true };
    } catch (err) {
      // Only retry on transient errors (not indexed/confirmed yet, network failures).
      // Deterministic validation failures (wrong sender, wrong type, etc.) are
      // returned immediately above as { ok: false }.
      if (
        err instanceof Error &&
        !err.message.includes("not indexed yet") &&
        !err.message.includes("not confirmed yet") &&
        !err.message.includes("Failed") &&
        !err.message.includes("fetch")
      ) {
        console.error("[verifyPayment] Unexpected error:", err);
        return { ok: false, reason: "Payment verification error" };
      }
    }

    // Wait before retrying
    await new Promise(function (resolve) {
      setTimeout(resolve, BASE_DELAY_MS + Math.random() * 1000);
    });
  }

  return { ok: false, reason: "Transaction could not be confirmed on the indexer. Please try again." };
}

async function verifyOwnership({
  assetId,
  walletAddress,
}: {
  assetId: number;
  walletAddress: string;
}): Promise<boolean> {
  try {
    const indexerUrl = `${INDEXER_BASE_URL}/v2/accounts/${walletAddress}/assets?asset-id=${assetId}`;
    const res = await fetch(indexerUrl);

    if (!res.ok) return false;

    const data = await res.json();
    const assets = data.assets ?? [];

    return assets.some(
      (a: { "asset-id": number; amount: number }) =>
        a["asset-id"] === assetId && a.amount > 0
    );
  } catch {
    return false;
  }
}

async function fetchCurrentMetadata(
  assetId: number
): Promise<NftMetadata | null> {
  try {
    const indexerUrl = `${INDEXER_BASE_URL}/v2/assets/${assetId}`;
    const res = await fetch(indexerUrl);

    if (!res.ok) return null;

    const data = await res.json();
    const url: string = data.asset?.params?.url ?? "";
    const reserve: string | undefined = data.asset?.params?.reserve;

    let metadataUrl: string | null = null;

    if (url.startsWith("template-ipfs://") || url.startsWith("ipfs://")) {
      // Use resolveArc19Url to handle both ARC-19 template URLs and
      // plain ipfs:// URLs. The reserve address is needed to derive
      // the IPFS CID for ARC-19 template URLs.
      metadataUrl = resolveArc19Url(url, reserve);
    } else if (url.startsWith("https://")) {
      // Block requests to private/internal hostnames to prevent SSRF
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        if (isBlockedHostname(hostname)) {
          metadataUrl = null;
        } else {
          metadataUrl = url;
        }
      } catch {
        metadataUrl = null;
      }
    }
    // Block plain http:// to prevent SSRF to internal services

    if (!metadataUrl) return null;

    const metaRes = await fetch(metadataUrl, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });

    if (!metaRes.ok) return null;

    return (await metaRes.json()) as NftMetadata;
  } catch {
    return null;
  }
}
