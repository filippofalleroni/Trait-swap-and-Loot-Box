import { NextRequest, NextResponse } from "next/server";
import algosdk from "algosdk";
import { getAlgodClient } from "@/lib/algorand";
import { getTreasuryAddress } from "@/lib/treasury";
import { feeConfig } from "@/config/fees";
import { mockTraits } from "@/config/mock-data";

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
          { error: `Trait '${newTraitId}' not found in registry` },
          { status: 404 }
        );
      }

      priceAlgo = trait.priceAlgo;
    }

    // Convert ALGO to microALGO
    const amountMicroAlgo = priceAlgo * 1_000_000;
    const treasuryAddress = getTreasuryAddress();

    // Build the unsigned payment transaction
    const algodClient = getAlgodClient();
    const suggestedParams = await algodClient.getTransactionParams().do();

    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: walletAddress,
      receiver: treasuryAddress,
      amount: amountMicroAlgo,
      suggestedParams,
      note: new TextEncoder().encode(
        JSON.stringify({ type: "trait-swap", traitId: newTraitId })
      ),
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
