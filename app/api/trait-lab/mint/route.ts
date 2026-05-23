import { NextRequest, NextResponse } from "next/server";
import { getAlgodClient, INDEXER_BASE_URL } from "@/lib/algorand";
import { getTreasuryAddress } from "@/lib/treasury";
import { getManagerAccount } from "@/lib/manager-signer";
import { uploadJsonToIpfs } from "@/lib/pinata";
import { computeArc19ReserveAddress, updateArc19Metadata } from "@/lib/arc19-update";
import { COLLECTION_CREATOR_ADDRESS } from "@/config/collection";
import { mockTraits } from "@/config/mock-data";
import { feeConfig } from "@/config/fees";
import type { NftMetadata, OfficialTraitCategory } from "@/lib/types";
import { isOfficialTraitCategory } from "@/lib/nft-layering";

/**
 * POST /api/trait-lab/mint
 *
 * Applies a trait change to an NFT after verifying payment.
 *
 * Request body:
 *   {
 *     nftAssetId: number,
 *     newTraitId: string,
 *     walletAddress: string,
 *     paymentTxId: string
 *   }
 *
 * Response:
 *   { status: "prepared" | "submitted", note: string }
 *
 * Modes:
 *   - Preview mode (default): Validates everything, returns "prepared"
 *     without making on-chain changes. Good for development.
 *   - Live mode (ARC19_LIVE_UPDATES_ENABLED=true): Uploads new metadata
 *     to IPFS and updates the ARC-19 reserve address on-chain.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { nftAssetId, newTraitId, walletAddress, paymentTxId } = body as {
      nftAssetId?: number;
      newTraitId?: string;
      walletAddress?: string;
      paymentTxId?: string;
    };

    // --- Validate required fields ---
    if (!nftAssetId || !newTraitId || !walletAddress || !paymentTxId) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: nftAssetId, newTraitId, walletAddress, paymentTxId",
        },
        { status: 400 }
      );
    }

    const isRemoval = newTraitId.startsWith("remove-");
    const removalCategory = isRemoval
      ? newTraitId.replace("remove-", "").toUpperCase()
      : null;

    // --- Look up the trait (if not a removal) ---
    let trait = null;
    if (!isRemoval) {
      trait = mockTraits.find((t) => t.id === newTraitId);
      if (!trait) {
        return NextResponse.json(
          { error: `Trait '${newTraitId}' not found` },
          { status: 404 }
        );
      }
    }

    // --- Verify the payment on-chain ---
    const paymentValid = await verifyPayment({
      txId: paymentTxId,
      expectedSender: walletAddress,
      expectedRecipient: getTreasuryAddress(),
      expectedAmountAlgo: isRemoval
        ? feeConfig.removalFeeAlgo
        : (trait?.priceAlgo ?? 0),
    });

    if (!paymentValid.ok) {
      return NextResponse.json(
        { error: `Payment verification failed: ${paymentValid.reason}` },
        { status: 400 }
      );
    }

    // --- Verify the wallet owns the NFT ---
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

    // --- Determine the category being changed ---
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

    // --- Check if live updates are enabled ---
    const isLive = process.env.ARC19_LIVE_UPDATES_ENABLED === "true";

    if (!isLive) {
      // Preview mode: just return success without on-chain changes
      return NextResponse.json({
        status: "prepared" as const,
        note: isRemoval
          ? `[Preview] Trait removal from category ${category} prepared for NFT ${nftAssetId}. Enable ARC19_LIVE_UPDATES_ENABLED to apply on-chain.`
          : `[Preview] Trait "${trait!.name}" (${category}) prepared for NFT ${nftAssetId}. Enable ARC19_LIVE_UPDATES_ENABLED to apply on-chain.`,
      });
    }

    // --- Live mode: build new metadata and update on-chain ---

    // Fetch current metadata for the NFT
    const currentMetadata = await fetchCurrentMetadata(nftAssetId);

    // Build updated metadata
    const updatedProperties = {
      ...(currentMetadata?.properties ?? {}),
    };

    if (isRemoval) {
      delete updatedProperties[category];
    } else {
      updatedProperties[category] = trait!.name;
    }

    const newMetadata: NftMetadata = {
      name: currentMetadata?.name ?? `NFT #${nftAssetId}`,
      description:
        currentMetadata?.description ?? "An NFT from this collection.",
      image: currentMetadata?.image ?? "",
      image_mimetype: "image/png",
      properties: updatedProperties,
      external_url: currentMetadata?.external_url,
    };

    // Upload new metadata to IPFS via Pinata
    const newCid = await uploadJsonToIpfs(newMetadata as unknown as Record<string, unknown>);

    // Compute the new ARC-19 reserve address from the CID
    const newReserveAddress = computeArc19ReserveAddress(newCid);

    // Update the on-chain reserve address
    const managerAccount = getManagerAccount();
    const updateTxId = await updateArc19Metadata({
      assetId: nftAssetId,
      newReserveAddress,
      managerAccount,
    });

    return NextResponse.json({
      status: "submitted" as const,
      note: isRemoval
        ? `Trait removed from category ${category} on NFT ${nftAssetId}. Update txId: ${updateTxId ?? "N/A"}`
        : `Trait "${trait!.name}" applied to NFT ${nftAssetId}. Update txId: ${updateTxId ?? "N/A"}`,
    });
  } catch (err) {
    console.error("[trait-lab/mint] Error:", err);
    return NextResponse.json(
      { error: "Mint process failed. Please try again." },
      { status: 500 }
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Verification Helpers                                              */
/* ------------------------------------------------------------------ */

/**
 * Verify a payment transaction exists on-chain with the expected
 * sender, recipient, and amount.
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
  try {
    const algodClient = getAlgodClient();

    // Wait for the transaction to be confirmed (up to 10 rounds)
    const result = await algodClient.pendingTransactionInformation(txId).do() as unknown as Record<string, unknown>;

    // Check if the transaction is confirmed
    if (!result || !(result["confirmed-round"] ?? result["confirmedRound"])) {
      // Try the indexer as a fallback (transaction might already be indexed)
      const indexerUrl = `${INDEXER_BASE_URL}/v2/transactions/${txId}`;
      const indexerRes = await fetch(indexerUrl);

      if (!indexerRes.ok) {
        return { ok: false, reason: "Transaction not found or not yet confirmed" };
      }

      const indexerData = await indexerRes.json();
      const txn = indexerData.transaction;

      if (!txn) {
        return { ok: false, reason: "Transaction data missing" };
      }

      // Verify sender
      if (txn.sender !== expectedSender) {
        return { ok: false, reason: "Sender mismatch" };
      }

      // Verify recipient
      const paymentDetails = txn["payment-transaction"];
      if (!paymentDetails || paymentDetails.receiver !== expectedRecipient) {
        return { ok: false, reason: "Recipient mismatch" };
      }

      // Verify amount (with small tolerance for rounding)
      const expectedMicroAlgo = expectedAmountAlgo * 1_000_000;
      if (paymentDetails.amount < expectedMicroAlgo) {
        return { ok: false, reason: "Insufficient payment amount" };
      }

      return { ok: true };
    }

    // Transaction found in pending info - it's confirmed
    return { ok: true };
  } catch (err) {
    console.error("[verifyPayment] Error:", err);
    return { ok: false, reason: "Payment verification error" };
  }
}

/**
 * Verify that the given wallet address currently holds the specified NFT.
 */
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

/**
 * Fetch the current ARC-19/ARC-69 metadata for an NFT.
 * Returns null if metadata cannot be resolved.
 */
async function fetchCurrentMetadata(
  assetId: number
): Promise<NftMetadata | null> {
  try {
    const indexerUrl = `${INDEXER_BASE_URL}/v2/assets/${assetId}`;
    const res = await fetch(indexerUrl);

    if (!res.ok) return null;

    const data = await res.json();
    const url: string = data.asset?.params?.url ?? "";

    // Resolve IPFS URL
    let metadataUrl: string | null = null;

    if (url.startsWith("ipfs://")) {
      metadataUrl = `https://ipfs.io/ipfs/${url.replace("ipfs://", "")}`;
    } else if (url.startsWith("https://") || url.startsWith("http://")) {
      metadataUrl = url;
    }

    if (!metadataUrl) return null;

    const metaRes = await fetch(metadataUrl, {
      signal: AbortSignal.timeout(5000),
    });

    if (!metaRes.ok) return null;

    return (await metaRes.json()) as NftMetadata;
  } catch {
    return null;
  }
}
