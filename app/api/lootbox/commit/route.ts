import { NextResponse } from "next/server";
import algosdk from "algosdk";
import { getAlgodClient } from "@/lib/algorand";
import { getTreasuryAddress } from "@/lib/treasury";

/* ------------------------------------------------------------------ */
/*  POST /api/lootbox/commit                                          */
/*                                                                    */
/*  Builds the unsigned payment + optional app call transactions      */
/*  for opening a loot box.                                           */
/* ------------------------------------------------------------------ */

const LOOTBOX_LIVE = process.env.LOOTBOX_LIVE_ENABLED === "true";
const CONTRACT_APP_ID = Number(process.env.LOOTBOX_CONTRACT_APP_ID ?? "0");
const CRATE_PRICE_MICRO =
  Number(process.env.LOOTBOX_PRICE_ALGO ?? "10") * 1_000_000;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { walletAddress } = body as { walletAddress?: string };

    if (!walletAddress) {
      return NextResponse.json(
        { error: "walletAddress is required" },
        { status: 400 }
      );
    }

    /* -------------------------------------------------------------- */
    /*  Preview / demo mode                                           */
    /* -------------------------------------------------------------- */

    if (!LOOTBOX_LIVE) {
      // Return a mock transaction so the frontend can be tested
      // without a real smart contract deployed.
      const algodClient = getAlgodClient();
      const suggestedParams = await algodClient.getTransactionParams().do();

      const treasuryAddr = getTreasuryAddress();

      const paymentTxn =
        algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: walletAddress,
          receiver: treasuryAddr,
          amount: CRATE_PRICE_MICRO,
          suggestedParams,
        });

      const txnBytes = paymentTxn.toByte();
      const b64 = Buffer.from(txnBytes).toString("base64");

      return NextResponse.json({
        txIds: [paymentTxn.txID()],
        unsignedTxns: [b64],
        mode: "preview",
      });
    }

    /* -------------------------------------------------------------- */
    /*  Live mode — payment + app call                                */
    /* -------------------------------------------------------------- */

    if (!CONTRACT_APP_ID) {
      return NextResponse.json(
        { error: "LOOTBOX_CONTRACT_APP_ID is not configured" },
        { status: 500 }
      );
    }

    const algodClient = getAlgodClient();
    const suggestedParams = await algodClient.getTransactionParams().do();
    const treasuryAddr = getTreasuryAddress();

    // 1. Payment transaction to treasury
    const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: walletAddress,
      receiver: treasuryAddr,
      amount: CRATE_PRICE_MICRO,
      suggestedParams,
    });

    // 2. App call to commit-reveal contract
    const appCallTxn =
      algosdk.makeApplicationCallTxnFromObject({
        sender: walletAddress,
        appIndex: CONTRACT_APP_ID,
        onComplete: algosdk.OnApplicationComplete.NoOpOC,
        appArgs: [new Uint8Array(Buffer.from("commit"))],
        suggestedParams,
      });

    // 3. Group the transactions
    const txns = [paymentTxn, appCallTxn];
    algosdk.assignGroupID(txns);

    // 4. Encode for transport
    const unsignedTxns = txns.map((txn) =>
      Buffer.from(txn.toByte()).toString("base64")
    );
    const txIds = txns.map((txn) => txn.txID());

    return NextResponse.json({
      txIds,
      unsignedTxns,
      mode: "live",
    });
  } catch (err: unknown) {
    console.error("[lootbox/commit]", err);
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
