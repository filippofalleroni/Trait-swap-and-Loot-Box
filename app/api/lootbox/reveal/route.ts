import { randomBytes, createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import algosdk from "algosdk";
import { ALGOD_BASE_URL, INDEXER_BASE_URL } from "@/lib/algorand";
import { getTreasuryAddress } from "@/lib/treasury";
import { resolvePrize } from "@/lib/lootbox-prize-resolver";
import { distributePrize, findExistingDistribution } from "@/lib/lootbox-distributor";
import { getLootboxMasterAccount, getLootboxMasterAddress } from "@/lib/lootbox-master-wallet";
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
// Randomness backend — must match the commit route. "block-seed" (default) draws
// randomness from the VRF seeds of blocks produced AFTER the payment confirms;
// "beacon" reads the on-chain commit-reveal contract's Randomness Beacon value.
const USE_BEACON =
  (process.env.LOOTBOX_RANDOMNESS_MODE ?? "block-seed").trim().toLowerCase() === "beacon";
// Block-seed mode: how many consecutive block seeds to hash. Biasing the result
// requires proposing this many consecutive blocks. 2 is a strong default; raise
// it for higher-value prizes, or drop to 1 for maximum speed.
const BLOCK_SEED_COUNT = Math.max(
  1,
  Number(process.env.LOOTBOX_BLOCK_SEED_COUNT ?? "2") || 2
);
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
// A live open legitimately calls reveal twice (the roll, then the claim after
// an asset opt-in) plus the occasional retry — allow headroom for that.
const RATE_LIMIT_MAX = 12;

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

const SAFE_ERROR_MAP: Record<string, string> = {
  "A valid wallet address is required.": "A valid wallet address is required.",
  "A payment transaction ID is required.": "A payment transaction ID is required.",
  "A reveal transaction ID is required.": "A reveal transaction ID is required.",
  "Invalid transaction ID format.": "Invalid transaction ID format.",
  "This transaction has already been used.": "This transaction has already been used.",
  "Payment sender does not match connected wallet.": "Payment does not match your connected wallet.",
  "Payment was not sent to the treasury address.": "Payment was sent to the wrong address. Please try again.",
  "Transaction is not a payment transaction.": "Invalid transaction type. Please try again.",
  "Transaction contains a rekey field and is rejected.": "Transaction rejected for security reasons.",
  "Transaction contains a close-remainder-to field and is rejected.": "Transaction rejected for security reasons.",
  "Transaction is too old. Please submit a new payment.": "Payment has expired. Please open a new loot box.",
  "Loot box is temporarily paused.": "Loot box is temporarily paused.",
  "No prizes are currently available.": "No prizes are currently available. Please try again later.",
  "Payment transaction not confirmed. Please try again.": "Payment could not be confirmed yet. Please wait a moment and try again.",
  "Payment must be part of a commit transaction group.": "Invalid payment format. Please try again.",
  "Reveal transaction not confirmed. Please try again.": "Reveal could not be confirmed yet. Please wait a moment and try again.",
  "Reveal transaction is not an application call.": "Invalid reveal transaction. Please try again.",
  "Reveal transaction targets wrong contract.": "Reveal targeted the wrong contract. Please try again.",
  "Reveal sender does not match wallet.": "Reveal does not match your connected wallet.",
  "Reveal transaction has unexpected on-completion type.": "Invalid reveal transaction type.",
  "Reveal transaction does not call the reveal() method.": "Invalid reveal method call.",
  "Reveal transaction is too old. Please try again.": "Reveal has expired. Please try again.",
  "Reveal transaction has no ABI return value.": "Reveal did not return a result. Please try again.",
  "Transaction round time is in the future.": "Payment timestamp is invalid. Please try again.",
  "Reveal transaction round time is in the future.": "Reveal timestamp is invalid. Please try again.",
  "Master wallet has insufficient balance for this prize.": "This prize is temporarily out of stock. Please contact support.",
  "Randomness is still finalizing. Please try again.": "Randomness is still finalizing. Please wait a moment and try again.",
};

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const mapped = SAFE_ERROR_MAP[error.message];
    if (mapped) return mapped;
  }
  if (error instanceof Error && error.message.startsWith("Payment amount")) {
    return "Payment amount is insufficient.";
  }
  if (error instanceof Error && error.message.includes("opted into")) {
    return error.message;
  }
  return "Loot box reveal failed. Please try again.";
}

export async function POST(request: NextRequest) {
  let claimedTxId: string | null = null;
  let claimedRevealTxId: string | null = null;

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

    const prizes: PrizeTier[] = await getPrizes();
    if (prizes.length === 0) {
      return NextResponse.json(
        { error: "No prizes are currently available." },
        { status: 500 }
      );
    }

    // Idempotency: if this payment already has an on-chain distribution, the
    // user already received their prize (a previous response may have been
    // lost). Return success instead of re-distributing. This both recovers a
    // stuck retry and prevents any double payout — even across cold starts,
    // because the proof of delivery lives on-chain, not in memory.
    if (LOOTBOX_LIVE) {
      const prior = await findExistingDistribution(getLootboxMasterAddress(), paymentTxId);
      if (prior) {
        const wonPrize = prizes.find((p) => p.id === prior.prizeId);
        return NextResponse.json({
          prize: wonPrize
            ? {
                id: wonPrize.id,
                name: wonPrize.name,
                type: wonPrize.type,
                rarity: wonPrize.rarity,
                color: wonPrize.color,
              }
            : undefined,
          paymentTxId,
          distributionTxId: prior.txId,
          status: "already_distributed",
        });
      }
    }

    pruneUsedTxIds();
    // In-flight lock (per serverless instance): block a second *concurrent*
    // request for the same payment, but release it in `finally` so a later
    // retry is never permanently dead-ended. The durable guard against a double
    // payout is the on-chain idempotency check above and in the distributor.
    if (usedPaymentTxIds.has(paymentTxId)) {
      return NextResponse.json(
        { error: "This loot box is already being processed. Please wait a moment." },
        { status: 409 }
      );
    }
    usedPaymentTxIds.add(paymentTxId);
    usedTxTimestamps.set(paymentTxId, Date.now());
    claimedTxId = paymentTxId;

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

    let randomValue: number;

    if (USE_BEACON) {
      // Beacon mode: the user has already submitted an on-chain reveal() call;
      // verify it and read the contract's VRF return value.

      if (!CONTRACT_APP_ID) {
        throw new Error("Loot box contract is not configured.");
      }

      // Verify the payment is in an atomic group (payment + app call commit)
      if (!txnInfo.group) {
        throw new Error("Payment must be part of a commit transaction group.");
      }

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
        return NextResponse.json(
          { error: "This loot box is already being processed. Please wait a moment." },
          { status: 409 }
        );
      }

      // Claim the revealTxId immediately to prevent a race condition where
      // two concurrent requests both pass the has() check above before
      // either reaches the add(). Released in `finally`, so it's an in-flight
      // lock rather than a permanent burn. Same pattern as paymentTxId above.
      usedRevealTxIds.add(revealTxId);
      usedTxTimestamps.set(revealTxId, Date.now());
      claimedRevealTxId = revealTxId;

      // Verify the on-chain reveal and read the ABI return value
      const revealInfo = await verifyRevealTransaction(
        revealTxId,
        walletAddress,
        CONTRACT_APP_ID
      );

      // Derive randomness from the contract's return value (uint64 from VRF
      // seed). Use upper 32 bits for a [0, 1) float.
      randomValue = Number(revealInfo.returnValue >> BigInt(32)) / 0x100000000;
    } else {
      // Block-seed mode: no contract and no second transaction. Randomness is
      // derived from the VRF seeds of the blocks AFTER the verified payment's
      // confirmed round, mixed with the payment txid. verifyPayment above
      // already proved the payment is real, recent, correctly addressed, and
      // confirmed — its round anchors the draw.
      if (!txnInfo.confirmedRound) {
        throw new Error("Payment transaction not confirmed. Please try again.");
      }
      randomValue = await blockSeedRandomness(txnInfo.confirmedRound, paymentTxId);
    }

    // Drop NFT tiers the master wallet no longer holds (e.g. a one-of-one that
    // was already won) so the draw can't land on an undeliverable prize. Token
    // and ALGO tiers are always deliverable (subject to balance).
    const heldIds = await getMasterHeldAssetIds(getLootboxMasterAddress());
    const deliverable = heldIds
      ? prizes.filter((p) => p.type !== "nft" || heldIds.has(p.assetId))
      : prizes;
    if (deliverable.length === 0) {
      throw new Error("No prizes are currently available.");
    }

    // The draw is a pure function of on-chain data (block seeds + txid, or the
    // contract's logged VRF value) over the deliverable pool — so a repeat call
    // for the same payment recomputes the SAME prize. That's what makes the
    // opt-in round-trip below safe without any server-side prize lock.
    const prize = resolvePrize(deliverable, randomValue);

    // ASA prizes can only be received by accounts opted into the asset. If the
    // winner isn't opted in yet, tell the client which asset to opt into; it
    // opts in (a free transaction) and calls back, and the deterministic
    // recompute above lands on the same prize for delivery.
    if (prize.assetId > 0 && !(await isOptedIn(walletAddress, prize.assetId))) {
      return NextResponse.json({
        status: "needs-optin",
        assetId: prize.assetId,
        prize: {
          id: prize.id,
          name: prize.name,
          type: prize.type,
          rarity: prize.rarity,
          color: prize.color,
        },
        paymentTxId,
      });
    }

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

    let distributionTxId: string;
    try {
      const masterAccount = getLootboxMasterAccount();
      const distResult = await distributePrize({
        prize,
        recipientAddress: walletAddress,
        masterAccount,
        algodClient,
        paymentTxId,
      });
      distributionTxId = distResult.txId;
    } catch (distErr: unknown) {
      console.error("[lootbox/reveal] Distribution failed:", distErr);
      // The in-flight locks are released in `finally`, so the user can safely
      // retry — distributePrize is idempotent on paymentTxId and will reuse an
      // existing on-chain transfer rather than sending a second one.
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
    console.error("[lootbox/reveal]", err);
    return NextResponse.json(
      { error: safeErrorMessage(err) },
      { status: 500 }
    );
  } finally {
    // Always release the in-flight locks. The durable guard against a double
    // payout is the on-chain idempotency check (here and in the distributor),
    // not these in-memory sets — so releasing lets a later retry recover
    // without ever risking a re-send.
    if (claimedTxId) {
      usedPaymentTxIds.delete(claimedTxId);
      usedTxTimestamps.delete(claimedTxId);
    }
    if (claimedRevealTxId) {
      usedRevealTxIds.delete(claimedRevealTxId);
      usedTxTimestamps.delete(claimedRevealTxId);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Opt-in + deliverability checks                                      */
/* ------------------------------------------------------------------ */

// Whether `address` holds (is opted into) `assetId`. Uses algod rather than the
// indexer so a just-confirmed opt-in is seen immediately — the client opts in,
// then calls straight back to claim, and that retry must not bounce on
// indexer lag.
async function isOptedIn(address: string, assetId: number): Promise<boolean> {
  try {
    const algodClient = getAlgodClient();
    const info = (await algodClient.accountInformation(address).do()) as unknown as Record<string, unknown>;
    const assets = info["assets"] as Array<Record<string, unknown>> | undefined;
    return Boolean(
      assets?.some((a) => Number(a["asset-id"] ?? a["assetId"] ?? a["asset_id"]) === assetId)
    );
  } catch {
    return false;
  }
}

// The set of asset ids the master wallet currently holds with a positive
// balance. Used to drop NFT tiers that can no longer be delivered (e.g. a
// one-of-one that was already won) before the prize is drawn.
async function getMasterHeldAssetIds(masterAddress: string): Promise<Set<number> | null> {
  try {
    const algodClient = getAlgodClient();
    const info = (await algodClient.accountInformation(masterAddress).do()) as unknown as Record<string, unknown>;
    const assets = info["assets"] as Array<Record<string, unknown>> | undefined;
    return new Set(
      (assets ?? [])
        .filter((a) => Number(a["amount"] ?? 0) > 0)
        .map((a) => Number(a["asset-id"] ?? a["assetId"] ?? a["asset_id"]))
    );
  } catch {
    // On failure, return null and let the caller keep the full pool — the
    // distributor still refuses to send anything the master doesn't hold.
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Block-seed randomness                                               */
/* ------------------------------------------------------------------ */

// Wrap fetch with an abort timeout so a slow or hanging upstream (node,
// indexer) fails fast and the caller's retry loop handles it, instead of one
// stuck request consuming the whole serverless function budget.
async function fetchWithTimeout(url: string, ms = 4000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Read a block's 32-byte VRF seed from algod. Retries briefly: a node can
// report a higher last-round a moment before the block itself is servable.
async function getBlockSeed(round: number): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetchWithTimeout(`${ALGOD_BASE_URL}/v2/blocks/${round}?format=json`);
      if (res.ok) {
        const seedB64 = (await res.json())?.block?.seed;
        if (seedB64 && typeof seedB64 === "string") return Buffer.from(seedB64, "base64");
      }
      lastErr = new Error(`Block ${round} not available yet.`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Block ${round} not available yet.`);
}

// Derive the random value for a payment: SHA-256 over the VRF seeds of the
// BLOCK_SEED_COUNT blocks AFTER the payment's confirmed round, plus the payment
// txid. The seeds don't exist yet when the buyer signs (unpredictable), the
// txid binds the draw to this specific payment (two buyers in the same round
// get independent results), and anyone can recompute the value from public
// chain data to verify their prize. Waits for the needed blocks first.
async function blockSeedRandomness(paymentRound: number, paymentTxId: string): Promise<number> {
  const lastNeeded = paymentRound + BLOCK_SEED_COUNT;
  const algodClient = getAlgodClient();
  let ready = false;
  for (let i = 0; i < 20; i++) {
    const status = (await algodClient.status().do()) as unknown as Record<string, unknown>;
    const last = Number(status["lastRound"] ?? status["last-round"] ?? 0);
    if (last >= lastNeeded) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!ready) {
    throw new Error("Randomness is still finalizing. Please try again.");
  }
  const hash = createHash("sha256");
  for (let i = 1; i <= BLOCK_SEED_COUNT; i++) {
    hash.update(await getBlockSeed(paymentRound + i));
  }
  hash.update(Buffer.from(paymentTxId));
  // Upper 32 bits of the digest as a [0, 1) float — same normalization the
  // beacon path uses, so resolvePrize sees an identical distribution.
  return hash.digest().readUInt32BE(0) / 0x100000000;
}

/* ------------------------------------------------------------------ */
/*  Payment verification (with indexer retry loop)                     */
/* ------------------------------------------------------------------ */

async function verifyPayment(
  txId: string,
  expectedSender: string,
  expectedReceiver: string,
  expectedAmountMicroAlgo: number
): Promise<{ ok: boolean; reason?: string; group?: string; confirmedRound?: number }> {
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

      return { ok: true, group, confirmedRound: Number(txn["confirmed-round"]) };
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
