import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import algosdk from "algosdk";
import { getAlgodClient, INDEXER_BASE_URL } from "@/lib/algorand";
import { lootboxConfig } from "@/config/lootbox";
import { getTreasuryAddress } from "@/lib/treasury";
import { resolvePrize } from "@/lib/lootbox-prize-resolver";
import { distributePrize } from "@/lib/lootbox-distributor";
import { getLootboxMasterAccount } from "@/lib/lootbox-master-wallet";
import { getPrizes } from "@/lib/lootbox-prize-store";
import type { PrizeTier } from "@/lib/types";

const LOOTBOX_LIVE = process.env.LOOTBOX_LIVE_ENABLED === "true";
const LOOTBOX_PAUSED = process.env.LOOTBOX_PAUSED === "true";
const ALGO_TXID_REGEX = /^[A-Z2-7]{52}$/;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

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

const usedTxIds = new Set<string>();
const usedTxTimestamps = new Map<string, number>();
const MAX_USED_TX_AGE_MS = 1000 * 60 * 60;

function pruneUsedTxIds() {
  const now = Date.now();
  usedTxTimestamps.forEach((ts, txId) => {
    if (now - ts > MAX_USED_TX_AGE_MS) {
      usedTxIds.delete(txId);
      usedTxTimestamps.delete(txId);
    }
  });
}

const SAFE_ERRORS = new Set([
  "A valid wallet address is required.",
  "A payment transaction ID is required.",
  "Invalid transaction ID format.",
  "This transaction has already been used.",
  "Payment sender does not match connected wallet.",
  "Payment was not sent to the treasury address.",
  "Transaction is not a payment transaction.",
  "Transaction contains a rekey field and is rejected.",
  "Transaction contains a close-remainder-to field and is rejected.",
  "Transaction is too old. Please submit a new payment.",
  "Loot box is temporarily paused.",
  "No prizes are currently available.",
  "Payment amount is insufficient.",
  "Payment transaction not confirmed. Please try again.",
]);

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && SAFE_ERRORS.has(error.message)) {
    return error.message;
  }
  if (error instanceof Error && error.message.startsWith("Payment amount")) {
    return "Payment amount is insufficient.";
  }
  return "Loot box reveal failed. Please try again.";
}

export async function POST(request: Request) {
  let claimedTxId: string | null = null;

  try {
    const body = await request.json();
    const { walletAddress, paymentTxId } = body as {
      walletAddress?: string;
      paymentTxId?: string;
    };

    if (!walletAddress || !algosdk.isValidAddress(walletAddress)) {
      return NextResponse.json(
        { error: "A valid wallet address is required." },
        { status: 400 }
      );
    }

    if (isRateLimited(walletAddress)) {
      return NextResponse.json(
        { error: "Too many attempts. Please wait a minute." },
        { status: 429 }
      );
    }

    if (!paymentTxId) {
      return NextResponse.json(
        { error: "A payment transaction ID is required." },
        { status: 400 }
      );
    }

    if (!ALGO_TXID_REGEX.test(paymentTxId)) {
      return NextResponse.json(
        { error: "Invalid transaction ID format." },
        { status: 400 }
      );
    }

    if (LOOTBOX_PAUSED) {
      return NextResponse.json(
        { error: "Loot box is temporarily paused." },
        { status: 503 }
      );
    }

    pruneUsedTxIds();
    if (usedTxIds.has(paymentTxId)) {
      return NextResponse.json(
        { error: "This transaction has already been used." },
        { status: 409 }
      );
    }
    usedTxIds.add(paymentTxId);
    usedTxTimestamps.set(paymentTxId, Date.now());
    claimedTxId = paymentTxId;

    const prizes: PrizeTier[] = await getPrizes();
    if (prizes.length === 0) {
      return NextResponse.json(
        { error: "No prizes are currently available." },
        { status: 500 }
      );
    }

    const treasuryAddress = getTreasuryAddress();
    const algodClient = getAlgodClient();

    const txnInfo = await verifyPayment(
      paymentTxId,
      walletAddress,
      treasuryAddress,
      lootboxConfig.cratePriceMicroAlgo
    );

    if (!txnInfo.ok) {
      throw new Error(txnInfo.reason!);
    }

    if (!LOOTBOX_LIVE) {
      if (claimedTxId) {
        usedTxIds.delete(claimedTxId);
        usedTxTimestamps.delete(claimedTxId);
      }

      const entropy = randomBytes(4);
      const randomValue = entropy.readUInt32BE(0) / 0xffffffff;
      const prize = resolvePrize(prizes, randomValue);

      return NextResponse.json({
        prize: {
          id: prize.id,
          name: prize.name,
          type: prize.type,
          rarity: prize.rarity,
          color: prize.color,
        },
        paymentTxId,
        distributionTxId: "preview-mode",
        status: "preview",
      });
    }

    const entropy = randomBytes(4);
    const randomValue = entropy.readUInt32BE(0) / 0xffffffff;
    const prize = resolvePrize(prizes, randomValue);

    let distributionTxId: string;
    try {
      const masterAccount = getLootboxMasterAccount();
      distributionTxId = await distributePrize({
        prize,
        recipientAddress: walletAddress,
        masterAccount,
        algodClient,
      });
    } catch (distErr: unknown) {
      console.error("[lootbox/reveal] Distribution failed:", distErr);
      return NextResponse.json(
        {
          error: "Prize distribution failed. Please contact support.",
          prize: {
            id: prize.id,
            name: prize.name,
            type: prize.type,
            rarity: prize.rarity,
            color: prize.color,
          },
          paymentTxId,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      prize: {
        id: prize.id,
        name: prize.name,
        type: prize.type,
        rarity: prize.rarity,
        color: prize.color,
      },
      paymentTxId,
      distributionTxId,
      status: "success",
    });
  } catch (err: unknown) {
    if (claimedTxId) {
      usedTxIds.delete(claimedTxId);
      usedTxTimestamps.delete(claimedTxId);
    }
    console.error("[lootbox/reveal]", err);
    return NextResponse.json(
      { error: safeErrorMessage(err) },
      { status: 500 }
    );
  }
}

async function verifyPayment(
  txId: string,
  expectedSender: string,
  expectedReceiver: string,
  expectedAmountMicroAlgo: number
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const indexerUrl = `${INDEXER_BASE_URL}/v2/transactions/${txId}`;
    const res = await fetch(indexerUrl);

    if (!res.ok) {
      return { ok: false, reason: "Payment transaction not confirmed. Please try again." };
    }

    const data = await res.json();
    const txn = data.transaction;
    if (!txn) {
      return { ok: false, reason: "Payment transaction not confirmed. Please try again." };
    }

    if (txn.sender !== expectedSender) {
      return { ok: false, reason: "Payment sender does not match connected wallet." };
    }

    const txType = txn["tx-type"];
    if (txType !== "pay") {
      return { ok: false, reason: "Transaction is not a payment transaction." };
    }

    // Reject transactions with rekey or close-remainder-to fields.
    // These could be used to piggyback malicious operations on a payment.
    if (txn["rekey-to"]) {
      return { ok: false, reason: "Transaction contains a rekey field and is rejected." };
    }

    const paymentDetails = txn["payment-transaction"];
    if (!paymentDetails || paymentDetails.receiver !== expectedReceiver) {
      return { ok: false, reason: "Payment was not sent to the treasury address." };
    }

    if (paymentDetails["close-remainder-to"]) {
      return { ok: false, reason: "Transaction contains a close-remainder-to field and is rejected." };
    }

    if (paymentDetails.amount < expectedAmountMicroAlgo) {
      return {
        ok: false,
        reason: `Payment amount is insufficient. Expected ${expectedAmountMicroAlgo / 1e6} ALGO.`,
      };
    }

    // Reject transactions older than 5 minutes to limit replay window
    const roundTime = txn["round-time"];
    if (roundTime != null && roundTime > 0) {
      const txAge = Math.floor(Date.now() / 1000) - roundTime;
      if (txAge > 300) {
        return { ok: false, reason: "Transaction is too old. Please submit a new payment." };
      }
    }

    return { ok: true };
  } catch (err) {
    console.error("[verifyPayment]", err);
    return { ok: false, reason: "Payment transaction not confirmed. Please try again." };
  }
}
