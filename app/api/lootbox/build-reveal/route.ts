import crypto from "crypto";
import { NextResponse } from "next/server";
import algosdk from "algosdk";
import { getAlgodClient } from "@/lib/algorand";

const CONTRACT_APP_ID = Number(process.env.LOOTBOX_CONTRACT_APP_ID ?? "0");

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

    if (!CONTRACT_APP_ID) {
      return NextResponse.json(
        { error: "Loot box contract is not configured." },
        { status: 500 }
      );
    }

    const algodClient = getAlgodClient();
    const suggestedParams = await algodClient.getTransactionParams().do();

    const revealSelector = new Uint8Array(
      Buffer.from(
        crypto.createHash("sha512-256").update("reveal()uint64").digest()
      ).subarray(0, 4)
    );

    const senderPk = algosdk.decodeAddress(walletAddress).publicKey;

    const appCallTxn = algosdk.makeApplicationCallTxnFromObject({
      sender: walletAddress,
      appIndex: CONTRACT_APP_ID,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [revealSelector],
      boxes: [{ appIndex: CONTRACT_APP_ID, name: senderPk }],
      suggestedParams,
    });

    const b64 = Buffer.from(appCallTxn.toByte()).toString("base64");

    return NextResponse.json({
      txId: appCallTxn.txID(),
      unsignedTxn: b64,
    });
  } catch (err: unknown) {
    console.error("[lootbox/build-reveal]", err);
    return NextResponse.json(
      { error: "Failed to build reveal transaction." },
      { status: 500 }
    );
  }
}
