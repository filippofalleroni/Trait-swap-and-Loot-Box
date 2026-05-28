import "server-only";
import { NextRequest, NextResponse } from "next/server";
import algosdk from "algosdk";
import { getAlgodClient } from "@/lib/algorand";
import { getTreasuryAddress } from "@/lib/treasury";
import { feeConfig } from "@/config/fees";
import { mockTraits } from "@/config/mock-data";
import { TRAIT_ID_REGEX } from "@/lib/types";

const PAYMENT_NOTE_PREFIX = "traitswap:";

/* ------------------------------------------------------------------ */
/*  Rate limiting                                                      */
/* ------------------------------------------------------------------ */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const ipRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
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

/**
 * POST /api/trait-lab/payment-tx
 *
 * Creates an unsigned payment transaction for a trait swap or removal.
 *
 * Request body:
 *   { walletAddress: string, newTraitId: string }
 *
 * Response:
 *   { unsignedTxnBase64: string }
 *
 * The transaction sends the trait price (in ALGO) from the user's
 * wallet to the treasury address. The user signs this client-side
 * and submits it before the mint endpoint finalizes the swap.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { walletAddress, newTraitId } = body as {
      walletAddress?: string;
      newTraitId?: string;
    };

    if (!walletAddress || !newTraitId) {
      return NextResponse.json(
        { error: "Missing required fields: walletAddress, newTraitId" },
        { status: 400 }
      );
    }

    // Validate the wallet address format
    if (!algosdk.isValidAddress(walletAddress)) {
      return NextResponse.json(
        { error: "Invalid wallet address" },
        { status: 400 }
      );
    }

    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (isIpRateLimited(clientIp)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    if (isRateLimited(walletAddress)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    if (!TRAIT_ID_REGEX.test(newTraitId)) {
      return NextResponse.json(
        { error: "Invalid trait ID format." },
        { status: 400 }
      );
    }

    // Determine the price for this trait
    let priceAlgo: number;

    if (newTraitId.startsWith("remove-")) {
      // Removal uses the flat removal fee from config
      priceAlgo = feeConfig.removalFeeAlgo;
    } else {
      // Look up the trait price from the registry.
      // In production, replace this with a database or registry lookup.
      const trait = mockTraits.find((t) => t.id === newTraitId);

      if (!trait) {
        return NextResponse.json(
          { error: "Trait not found in registry." },
          { status: 404 }
        );
      }

      priceAlgo = trait.priceAlgo;
    }

    if (!Number.isFinite(priceAlgo) || priceAlgo <= 0) {
      return NextResponse.json(
        { error: "Invalid price configuration." },
        { status: 500 }
      );
    }
    const amountMicroAlgo = Math.round(priceAlgo * 1_000_000);
    if (amountMicroAlgo <= 0) {
      return NextResponse.json(
        { error: "Invalid price configuration." },
        { status: 500 }
      );
    }
    const treasuryAddress = getTreasuryAddress();

    // Build the unsigned payment transaction
    const algodClient = getAlgodClient();
    const suggestedParams = await algodClient.getTransactionParams().do();

    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: walletAddress,
      receiver: treasuryAddress,
      amount: amountMicroAlgo,
      suggestedParams,
      note: new TextEncoder().encode(`${PAYMENT_NOTE_PREFIX}${newTraitId}`),
    });

    // Encode the transaction to base64 for the client
    const txnBytes = algosdk.encodeUnsignedTransaction(txn);
    const unsignedTxnBase64 = Buffer.from(txnBytes).toString("base64");

    return NextResponse.json({ unsignedTxnBase64 });
  } catch (err) {
    console.error("[payment-tx] Error:", err);
    return NextResponse.json(
      { error: "Failed to create payment transaction" },
      { status: 500 }
    );
  }
}
