import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import algosdk from "algosdk";
import { INDEXER_BASE_URL } from "@/lib/algorand";
import { getTreasuryAddress } from "@/lib/treasury";
import { resolvePrize } from "@/lib/lootbox-prize-resolver";
import { distributePrize } from "@/lib/lootbox-distributor";
import { getLootboxMasterAccount } from "@/lib/lootbox-master-wallet";
import { getAlgodClient } from "@/lib/algorand";
import { getPrizes } from "@/lib/lootbox-prize-store";
import type { PrizeTier } from "@/lib/types";

/**
 * Allow this route up to 60 seconds for indexer retries + distribution +
 * waitForConfirmation. On Vercel, this requires a Pro plan for serverless
 * functions > 10 s.
 */
export const maxDuration = 60;

const LOOTBOX_LIVE = process.env.LOOTBOX_LIVE_ENABLED === "true";
const CONTRACT_APP_ID = Number(process.env.LOOTBOX_CONTRACT_APP_ID ?? "0");
const CRATE_PRICE_MICRO = Math.round(
  Number(process.env.LOOTBOX_PRICE_ALGO ?? "10") * 1_000_000
);
const ALGO_TXID_REGEX = /^[A-Z2-7]{52}$/;
const ABI_RETURN_PREFIX = Buffer.from("151f7c75", "hex");
const REVEAL_SELECTOR_B64 = Buffer.from("750ec9b5", "hex").toString("base64");
const MAX_PAYMENT_AGE_SECONDS = 600;
const MAX_REVEAL_AGE_SECONDS = 300;

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
const usedPaymentTxIds = new Set<string>();
const usedRevealTxIds = new Set<string>();
const usedTxTimestamps = new Map<string, number>();
const MAX_USED_TX_AGE_MS = 1000 * 60 * 60;

function pruneUsedTxIds() {
  const now = Date.now();
  usedTxTimestamps.forEach((ts, txId) => {
    if (now - ts > MAX_USED_TX_AGE_MS) {
      usedPaymentTxIds.delete(txId);
      usedRevealTxIds.delete(txId);
      usedTxTimestamps.delete(txId);
    }
  });
}

const SAFE_ERRORS = new Set([
  "A valid wallet address is required.",
  "A payment transaction ID is required.",
  "A reveal transaction ID is required.",
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
  "Payment must be part of a commit transaction group.",
  "Reveal transaction not confirmed. Please try again.",
  "Reveal transaction is not an application call.",
  "Reveal transaction targets wrong contract.",
  "Reveal sender does not match wallet.",
  "Reveal transaction has unexpected on-completion type.",
  "Reveal transaction does not call the reveal() method.",
  "Reveal transaction is too old. Please try again.",
  "Reveal transaction has no ABI return value.",
  "Transaction round time is in the future.",
  "Reveal transaction round time is in the future.",
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

export async function POST(request: NextRequest) {
  let claimedTxId: string | null = null;
  let claimedRevealTxId: string | null = null;
  let distributionAttempted = false;

  try {
    const clientIp = getClientIp(request);
    if (isIpRateLimited(clientIp)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { walletAddress, paymentTxId, revealTxId } = body as {
      walletAddress?: string;
      paymentTxId?: string;
      revealTxId?: string;
    };

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

    if (process.env.LOOTBOX_PAUSED === "true") {
      return NextResponse.json(
        { error: "Loot box is temporarily paused." },
        { status: 503 }
      );
    }

    pruneUsedTxIds();
    if (usedPaymentTxIds.has(paymentTxId)) {
      return NextResponse.json(
        { error: "This transaction has already been used." },
        { status: 409 }
      );
    }
    usedPaymentTxIds.add(paymentTxId);
    usedTxTimestamps.set(paymentTxId, Date.now());
    claimedTxId = paymentTxId;

    const prizes: PrizeTier[] = await getPrizes();
    if (prizes.length === 0) {
      if (claimedTxId) {
        usedPaymentTxIds.delete(claimedTxId);
        usedTxTimestamps.delete(claimedTxId);
      }
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
      CRATE_PRICE_MICRO
    );

    if (!txnInfo.ok) {
      throw new Error(txnInfo.reason!);
    }

    if (!LOOTBOX_LIVE) {
      // Preview mode: release the txId so it can be reused in testing
      if (claimedTxId) {
        usedPaymentTxIds.delete(claimedTxId);
        usedTxTimestamps.delete(claimedTxId);
      }

      const entropy = randomBytes(4);
      const randomValue = entropy.readUInt32BE(0) / 0x100000000;
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

    // --- Live mode ---

    if (!CONTRACT_APP_ID) {
      throw new Error("Loot box contract is not configured.");
    }

    // Verify the payment is in an atomic group (payment + app call commit)
    if (!txnInfo.group) {
      throw new Error("Payment must be part of a commit transaction group.");
    }

    // In live mode, the user must also submit an on-chain reveal() call.
    // Release the claimed paymentTxId on validation errors so the user can
    // retry with a corrected revealTxId.
    if (!revealTxId) {
      if (claimedTxId) {
        usedPaymentTxIds.delete(claimedTxId);
        usedTxTimestamps.delete(claimedTxId);
      }
      return NextResponse.json(
        { error: "A reveal transaction ID is required." },
        { status: 400 }
      );
    }

    if (!ALGO_TXID_REGEX.test(revealTxId)) {
      if (claimedTxId) {
        usedPaymentTxIds.delete(claimedTxId);
        usedTxTimestamps.delete(claimedTxId);
      }
      return NextResponse.json(
        { error: "Invalid transaction ID format." },
        { status: 400 }
      );
    }

    if (usedRevealTxIds.has(revealTxId)) {
      if (claimedTxId) {
        usedPaymentTxIds.delete(claimedTxId);
        usedTxTimestamps.delete(claimedTxId);
      }
      return NextResponse.json(
        { error: "This transaction has already been used." },
        { status: 409 }
      );
    }

    // Claim the revealTxId immediately to prevent a race condition where
    // two concurrent requests both pass the has() check above before
    // either reaches the add(). Same pattern as paymentTxId above.
    usedRevealTxIds.add(revealTxId);
    usedTxTimestamps.set(revealTxId, Date.now());
    claimedRevealTxId = revealTxId;

    // Verify the on-chain reveal and read the ABI return value
    const revealInfo = await verifyRevealTransaction(
      revealTxId,
      walletAddress,
      CONTRACT_APP_ID
    );

    // Derive randomness from the contract's return value (uint64 from VRF seed).
    // Use upper 32 bits for [0, 1) float — matches what extract3(seed, 0, 8)
    // would give when reading only the first 4 bytes.
    const upper32 = Number(revealInfo.returnValue >> BigInt(32));
    const randomValue = upper32 / 0x100000000;

    const prize = resolvePrize(prizes, randomValue);

    // Refuse to distribute if ALL prizes look unconfigured (assetId 0 AND amount 0).
    // Note: assetId 0 with amount > 0 is a valid ALGO prize.
    const allUnconfigured = prizes.every(function (p) {
      return p.assetId === 0 && p.amount === 0;
    });
    if (allUnconfigured) {
      if (claimedTxId) {
        usedPaymentTxIds.delete(claimedTxId);
        usedTxTimestamps.delete(claimedTxId);
      }
      if (claimedRevealTxId) {
        usedRevealTxIds.delete(claimedRevealTxId);
        usedTxTimestamps.delete(claimedRevealTxId);
      }
      return NextResponse.json(
        { error: "Prize configuration incomplete — no prizes configured." },
        { status: 500 }
      );
    }

    distributionAttempted = true;

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
      // Do NOT release paymentTxId or revealTxId here — the on-chain
      // distribution transaction may still confirm. The user should
      // contact support for manual resolution.
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
    // Only release claimed txIds for pre-distribution validation errors
    // so the user can retry. Once distribution was attempted, do NOT release
    // — the on-chain tx may still confirm, and releasing enables double-dist.
    if (!distributionAttempted) {
      if (claimedTxId) {
        usedPaymentTxIds.delete(claimedTxId);
        usedTxTimestamps.delete(claimedTxId);
      }
      if (claimedRevealTxId) {
        usedRevealTxIds.delete(claimedRevealTxId);
        usedTxTimestamps.delete(claimedRevealTxId);
      }
    }
    console.error("[lootbox/reveal]", err);
    return NextResponse.json(
      { error: safeErrorMessage(err) },
      { status: 500 }
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Payment verification (with indexer retry loop)                     */
/* ------------------------------------------------------------------ */

async function verifyPayment(
  txId: string,
  expectedSender: string,
  expectedReceiver: string,
  expectedAmountMicroAlgo: number
): Promise<{ ok: boolean; reason?: string; group?: string }> {
  const MAX_RETRIES = 12;
  const BASE_DELAY_MS = 2000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const delay = BASE_DELAY_MS + Math.random() * 1000;
    try {
      const indexerUrl = `${INDEXER_BASE_URL}/v2/transactions/${txId}`;
      const res = await fetch(indexerUrl);

      if (!res.ok) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(function (resolve) {
            setTimeout(resolve, delay);
          });
          continue;
        }
        return { ok: false, reason: "Payment transaction not confirmed. Please try again." };
      }

      const data = await res.json();
      const txn = data.transaction;
      if (!txn || !txn["confirmed-round"]) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(function (resolve) {
            setTimeout(resolve, delay);
          });
          continue;
        }
        return { ok: false, reason: "Payment transaction not confirmed. Please try again." };
      }

      if (txn.sender !== expectedSender) {
        return { ok: false, reason: "Payment sender does not match connected wallet." };
      }

      const txType = txn["tx-type"];
      if (txType !== "pay") {
        return { ok: false, reason: "Transaction is not a payment transaction." };
      }

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

      const roundTime = txn["round-time"];
      if (!roundTime || roundTime <= 0) {
        return { ok: false, reason: "Transaction missing round time" };
      }
      const txAge = Math.floor(Date.now() / 1000) - roundTime;
      if (txAge < 0) {
        return { ok: false, reason: "Transaction round time is in the future." };
      }
      if (txAge > MAX_PAYMENT_AGE_SECONDS) {
        return { ok: false, reason: "Transaction is too old. Please submit a new payment." };
      }

      const group = typeof txn.group === "string" ? txn.group : undefined;

      return { ok: true, group };
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(function (resolve) {
          setTimeout(resolve, delay);
        });
        continue;
      }
      console.error("[verifyPayment]", err);
      return { ok: false, reason: "Payment transaction not confirmed. Please try again." };
    }
  }

  return { ok: false, reason: "Payment transaction not confirmed. Please try again." };
}

/* ------------------------------------------------------------------ */
/*  Reveal transaction verification                                    */
/* ------------------------------------------------------------------ */

async function verifyRevealTransaction(
  txId: string,
  expectedSender: string,
  expectedAppId: number
): Promise<{ returnValue: bigint }> {
  const MAX_RETRIES = 10;
  const BASE_DELAY_MS = 2000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const delay = BASE_DELAY_MS + Math.random() * 1000;
    try {
      const indexerUrl = `${INDEXER_BASE_URL}/v2/transactions/${txId}`;
      const res = await fetch(indexerUrl);

      if (!res.ok) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(function (resolve) {
            setTimeout(resolve, delay);
          });
          continue;
        }
        throw new Error("Reveal transaction not confirmed. Please try again.");
      }

      const data = await res.json();
      const txn = data.transaction;
      if (!txn || !txn["confirmed-round"]) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(function (resolve) {
            setTimeout(resolve, delay);
          });
          continue;
        }
        throw new Error("Reveal transaction not confirmed. Please try again.");
      }

      if (txn["tx-type"] !== "appl") {
        throw new Error("Reveal transaction is not an application call.");
      }

      const appCallDetails = txn["application-transaction"];
      if (!appCallDetails || appCallDetails["application-id"] !== expectedAppId) {
        throw new Error("Reveal transaction targets wrong contract.");
      }

      if (txn.sender !== expectedSender) {
        throw new Error("Reveal sender does not match wallet.");
      }

      const onCompletion = appCallDetails["on-completion"];
      if (onCompletion !== "noop" && onCompletion !== undefined) {
        throw new Error("Reveal transaction has unexpected on-completion type.");
      }

      const appArgs = appCallDetails["application-args"] as string[] | undefined;
      if (!appArgs || appArgs.length !== 1 || appArgs[0] !== REVEAL_SELECTOR_B64) {
        throw new Error("Reveal transaction does not call the reveal() method.");
      }

      const roundTime = txn["round-time"];
      if (!roundTime || roundTime <= 0) {
        throw new Error("Reveal transaction missing round time.");
      }
      const txAge = Math.floor(Date.now() / 1000) - roundTime;
      if (txAge < 0) {
        throw new Error("Reveal transaction round time is in the future.");
      }
      if (txAge > MAX_REVEAL_AGE_SECONDS) {
        throw new Error("Reveal transaction is too old. Please try again.");
      }

      const logs = txn.logs as string[] | undefined;
      if (!logs || logs.length === 0) {
        throw new Error("Reveal transaction has no ABI return value.");
      }

      const lastLog = Buffer.from(logs[logs.length - 1], "base64");
      if (lastLog.length < 12 || !lastLog.subarray(0, 4).equals(ABI_RETURN_PREFIX)) {
        throw new Error("Reveal transaction has no ABI return value.");
      }

      const returnValue = lastLog.readBigUInt64BE(4);
      return { returnValue };
    } catch (err) {
      if (
        err instanceof Error &&
        !err.message.includes("not confirmed") &&
        !err.message.includes("Failed")
      ) {
        throw err;
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(function (resolve) {
          setTimeout(resolve, delay);
        });
        continue;
      }
      throw err;
    }
  }

  throw new Error("Reveal transaction not confirmed. Please try again.");
}
