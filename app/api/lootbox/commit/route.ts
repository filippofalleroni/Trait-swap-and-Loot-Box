import crypto from "crypto";
import { NextResponse } from "next/server";
import algosdk from "algosdk";
import { getAlgodClient } from "@/lib/algorand";
import { getTreasuryAddress } from "@/lib/treasury";

const LOOTBOX_LIVE = process.env.LOOTBOX_LIVE_ENABLED === "true";
const CONTRACT_APP_ID = Number(process.env.LOOTBOX_CONTRACT_APP_ID ?? "0");
// Randomness backend: "block-seed" (default — fast, 1 signature, no contract) or
// "beacon" (the on-chain commit-reveal contract using the Algorand Randomness
// Beacon — fully trustless, 2 signatures + a short wait).
const USE_BEACON =
  (process.env.LOOTBOX_RANDOMNESS_MODE ?? "block-seed").trim().toLowerCase() === "beacon";
const CRATE_PRICE_MICRO = Math.round(
  Number(process.env.LOOTBOX_PRICE_ALGO ?? "10") * 1_000_000
);

/* ------------------------------------------------------------------ */
/*  Rate limiting                                                      */
/* ------------------------------------------------------------------ */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

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

function getClientIp(request: Request): string {
  const forwarded = (request.headers as Headers).get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

export async function POST(request: Request) {
  try {
    const clientIp = getClientIp(request);
    if (isIpRateLimited(clientIp)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { walletAddress } = body as { walletAddress?: string };

    if (process.env.LOOTBOX_PAUSED === "true") {
      return NextResponse.json(
        { error: "Loot box is temporarily paused." },
        { status: 503 }
      );
    }

    if (!walletAddress || !algosdk.isValidAddress(walletAddress)) {
      return NextResponse.json(
        { error: "A valid wallet address is required." },
        { status: 400 }
      );
    }

    if (isRateLimited(walletAddress.toUpperCase())) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    const algodClient = getAlgodClient();
    const suggestedParams = await algodClient.getTransactionParams().do();
    const treasuryAddr = getTreasuryAddress();

    // The treasury payment is the same in every mode — it's the price of one open.
    const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: walletAddress,
      receiver: treasuryAddr,
      amount: CRATE_PRICE_MICRO,
      suggestedParams,
      note: new TextEncoder().encode("lootbox:open"),
    });

    // Preview: still build a real payment so the flow is identical, but the
    // reveal returns a sample prize without distributing anything.
    if (!LOOTBOX_LIVE) {
      return NextResponse.json({
        txIds: [paymentTxn.txID()],
        unsignedTxns: [Buffer.from(paymentTxn.toByte()).toString("base64")],
        paymentTxId: paymentTxn.txID(),
        mode: "preview",
      });
    }

    // Beacon mode: pay + on-chain commit() in one atomic group. The contract
    // locks a future Randomness Beacon round; the user signs a reveal() later.
    if (USE_BEACON) {
      if (!CONTRACT_APP_ID) {
        return NextResponse.json(
          { error: "Loot box contract is not configured." },
          { status: 500 }
        );
      }

      const commitSelector = new Uint8Array(
        Buffer.from(
          crypto.createHash("sha512-256").update("commit()void").digest()
        ).subarray(0, 4)
      );
      const senderPk = algosdk.decodeAddress(walletAddress).publicKey;
      const appCallTxn = algosdk.makeApplicationCallTxnFromObject({
        sender: walletAddress,
        appIndex: CONTRACT_APP_ID,
        onComplete: algosdk.OnApplicationComplete.NoOpOC,
        appArgs: [commitSelector],
        boxes: [{ appIndex: CONTRACT_APP_ID, name: senderPk }],
        suggestedParams,
      });

      const txns = [paymentTxn, appCallTxn];
      algosdk.assignGroupID(txns);

      return NextResponse.json({
        txIds: txns.map((txn) => txn.txID()),
        unsignedTxns: txns.map((txn) => Buffer.from(txn.toByte()).toString("base64")),
        paymentTxId: paymentTxn.txID(),
        mode: "live",
        randomnessMode: "beacon",
        contractAppId: CONTRACT_APP_ID,
      });
    }

    // Block-seed mode: a single payment, no contract. Randomness is derived from
    // the VRF seeds of the blocks AFTER this payment confirms (see the reveal
    // route) — unknowable when the user signs and bound to their payment txid,
    // so the open stays a single signature.
    return NextResponse.json({
      txIds: [paymentTxn.txID()],
      unsignedTxns: [Buffer.from(paymentTxn.toByte()).toString("base64")],
      paymentTxId: paymentTxn.txID(),
      mode: "live",
      randomnessMode: "block-seed",
    });
  } catch (err: unknown) {
    console.error("[lootbox/commit]", err);
    return NextResponse.json(
      { error: "Failed to build transaction." },
      { status: 500 }
    );
  }
}
