import { NextResponse } from "next/server";
import algosdk from "algosdk";
import { getAlgodClient } from "@/lib/algorand";
import { getTreasuryAddress } from "@/lib/treasury";

const LOOTBOX_LIVE = process.env.LOOTBOX_LIVE_ENABLED === "true";
const CONTRACT_APP_ID = Number(process.env.LOOTBOX_CONTRACT_APP_ID ?? "0");
const CRATE_PRICE_MICRO =
  Number(process.env.LOOTBOX_PRICE_ALGO ?? "10") * 1_000_000;

/* ------------------------------------------------------------------ */
/*  Rate limiting                                                      */
/* ------------------------------------------------------------------ */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

function pruneRateLimitMap() {
  const now = Date.now();
  rateLimitMap.forEach((entry, key) => {
    if (now >= entry.resetAt) rateLimitMap.delete(key);
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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { walletAddress } = body as { walletAddress?: string };

    if (!walletAddress || !algosdk.isValidAddress(walletAddress)) {
      return NextResponse.json(
        { error: "A valid wallet address is required." },
        { status: 400 }
      );
    }

    if (isRateLimited(walletAddress)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    const algodClient = getAlgodClient();
    const suggestedParams = await algodClient.getTransactionParams().do();
    const treasuryAddr = getTreasuryAddress();

    if (!LOOTBOX_LIVE) {
      const paymentTxn =
        algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: walletAddress,
          receiver: treasuryAddr,
          amount: CRATE_PRICE_MICRO,
          suggestedParams,
          note: new TextEncoder().encode("lootbox:open"),
        });

      const b64 = Buffer.from(paymentTxn.toByte()).toString("base64");

      return NextResponse.json({
        txIds: [paymentTxn.txID()],
        unsignedTxns: [b64],
        mode: "preview",
      });
    }

    if (!CONTRACT_APP_ID) {
      return NextResponse.json(
        { error: "Loot box contract is not configured." },
        { status: 500 }
      );
    }

    const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: walletAddress,
      receiver: treasuryAddr,
      amount: CRATE_PRICE_MICRO,
      suggestedParams,
      note: new TextEncoder().encode("lootbox:open"),
    });

    const appCallTxn =
      algosdk.makeApplicationCallTxnFromObject({
        sender: walletAddress,
        appIndex: CONTRACT_APP_ID,
        onComplete: algosdk.OnApplicationComplete.NoOpOC,
        appArgs: [new TextEncoder().encode("commit")],
        suggestedParams,
      });

    const txns = [paymentTxn, appCallTxn];
    algosdk.assignGroupID(txns);

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
    return NextResponse.json(
      { error: "Failed to build transaction." },
      { status: 500 }
    );
  }
}
