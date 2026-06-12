import { createHash } from "crypto";
import algosdk from "algosdk";
import type { PrizeTier } from "./types";
import { INDEXER_BASE_URL } from "./algorand";

/**
 * Server-only module for distributing loot box prizes.
 *
 * Sends the won prize (token transfer or NFT transfer) from the
 * master wallet to the winner's address.
 */

const DISTRIBUTION_NOTE_PREFIX = "lootbox-prize:";

/**
 * Distribution note format: `lootbox-prize:<paymentTxId>:<prizeId>`.
 *
 * The paymentTxId comes first so an existing delivery for a given payment can
 * be located with a single indexer note-prefix query. This is what ties an
 * off-chain payment to its on-chain payout and makes distribution idempotent.
 */
function buildDistributionNote(paymentTxId: string, prizeId: string): string {
  return `${DISTRIBUTION_NOTE_PREFIX}${paymentTxId}:${prizeId}`;
}

/**
 * Idempotency guard. Returns the existing on-chain distribution for a payment
 * (its txId and the prize id parsed from the note), or null if none exists.
 *
 * This prevents a payment from ever being paid out twice — even if the server
 * crashed or cold-started after a successful transfer, since the proof of
 * delivery lives on-chain rather than in volatile memory.
 */
export async function findExistingDistribution(
  masterAddress: string,
  paymentTxId: string
): Promise<{ txId: string; prizeId: string | null } | null> {
  try {
    const prefix = `${DISTRIBUTION_NOTE_PREFIX}${paymentTxId}:`;
    const notePrefixB64 = Buffer.from(prefix).toString("base64");
    // No tx-type filter: a prize may be an ALGO payment OR an asset transfer.
    const url =
      `${INDEXER_BASE_URL}/v2/transactions` +
      `?address=${masterAddress}&address-role=sender` +
      `&note-prefix=${encodeURIComponent(notePrefixB64)}&limit=1`;
    // Abort a slow indexer rather than letting one stuck request consume the
    // serverless function's whole time budget.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    let res: Response;
    try {
      res = await fetch(url, { cache: "no-store", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = await res.json();
    const txn = data?.transactions?.[0];
    if (!txn?.id) return null;

    let prizeId: string | null = null;
    if (typeof txn.note === "string") {
      try {
        const decoded = Buffer.from(txn.note, "base64").toString("utf-8");
        if (decoded.startsWith(prefix)) {
          prizeId = decoded.slice(prefix.length) || null;
        }
      } catch {
        // Non-UTF8 note — ignore; the txId alone is enough to dedupe.
      }
    }
    return { txId: txn.id, prizeId };
  } catch {
    // On indexer error, return null rather than blocking a legitimate delivery.
    return null;
  }
}

/**
 * Verify that the recipient has opted in to the prize asset before
 * attempting the transfer. Throws if they have not.
 */
async function verifyRecipientOptedIn(
  algodClient: algosdk.Algodv2,
  recipientAddress: string,
  assetId: number
): Promise<void> {
  try {
    const accountInfo = await algodClient
      .accountInformation(recipientAddress)
      .do();
    const assets = (
      accountInfo as unknown as Record<string, unknown>
    )["assets"] as Array<Record<string, unknown>> | undefined;

    const assetMatch = assets?.some(function (a) {
      const id = a["asset-id"] ?? a["assetId"] ?? a["asset_id"];
      return Number(id) === assetId;
    });
    if (!assetMatch) {
      throw new Error(
        `Recipient has not opted into asset ${assetId}. Please opt in before claiming prizes.`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("opted into")) {
      throw error;
    }
    throw new Error("Failed to verify recipient asset opt-in status.");
  }
}

export async function distributePrize({
  prize,
  recipientAddress,
  masterAccount,
  algodClient,
  paymentTxId,
}: {
  prize: PrizeTier;
  recipientAddress: string;
  masterAccount: algosdk.Account;
  algodClient: algosdk.Algodv2;
  paymentTxId: string;
}): Promise<{ txId: string; alreadyDistributed: boolean }> {
  // masterAccount.addr is an Address object in algosdk v3; use .toString()
  // for string contexts to avoid implicit coercion issues.
  const masterAddr = masterAccount.addr.toString();

  // Idempotency: if this payment already has an on-chain distribution, reuse it
  // instead of sending again.
  const existing = await findExistingDistribution(masterAddr, paymentTxId);
  if (existing) {
    return { txId: existing.txId, alreadyDistributed: true };
  }

  // Pre-flight balance check: verify the master wallet can cover the prize.
  const masterInfo = (await algodClient
    .accountInformation(masterAddr)
    .do()) as unknown as Record<string, unknown>;
  const masterBalanceMicro = Number(masterInfo?.amount ?? 0);
  const masterMinBalance = Number(masterInfo?.["min-balance"] ?? masterInfo?.["minBalance"] ?? 100_000);
  const MIN_FEE = 1000;
  const availableBalance = masterBalanceMicro - masterMinBalance;

  if (prize.assetId === 0) {
    if (availableBalance < prize.amount + MIN_FEE) {
      throw new Error("Master wallet has insufficient balance for this prize.");
    }
  } else {
    if (availableBalance < MIN_FEE) {
      throw new Error("Master wallet has insufficient balance for this prize.");
    }
    const assets = (masterInfo.assets ?? []) as unknown as Array<
      Record<string, unknown>
    >;
    const assetHolding = assets.find(function (a) {
      const id = a["asset-id"] ?? a["assetId"] ?? a["asset_id"];
      return Number(id) === prize.assetId;
    });
    const heldAmount = Number(assetHolding?.amount ?? 0);
    const requiredAmount = prize.type === "nft" ? 1 : prize.amount;
    if (heldAmount < requiredAmount) {
      throw new Error("Master wallet has insufficient balance for this prize.");
    }
  }

  // ASA prizes require the recipient to have opted in first.
  if (prize.assetId !== 0) {
    await verifyRecipientOptedIn(algodClient, recipientAddress, prize.assetId);
  }

  const suggestedParams = await algodClient.getTransactionParams().do();
  const note = new TextEncoder().encode(buildDistributionNote(paymentTxId, prize.id));

  // Lease = an on-chain mutex keyed to the payment. The chain confirms at most
  // ONE transaction per (sender, lease) within a validity window, so even two
  // server instances that both passed the indexer idempotency check (indexer
  // lag) and built DIFFERENT transactions for the same payment can't both pay
  // out — the second is rejected by consensus, not by our bookkeeping.
  const lease = new Uint8Array(createHash("sha256").update(paymentTxId).digest());

  // Build and sign the transfer ONCE so every retry resends the *same* txid.
  // Algorand dedupes by txid, so even if a send's waitForConfirmation timed out
  // on a txn that actually landed, resending can never produce a second
  // transfer — the network commits this txid at most once.
  const txn =
    prize.assetId === 0
      ? algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: masterAddr,
          receiver: recipientAddress,
          amount: prize.amount,
          suggestedParams,
          note,
          lease,
        })
      : algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender: masterAddr,
          receiver: recipientAddress,
          assetIndex: prize.assetId,
          amount: prize.type === "nft" ? 1 : prize.amount,
          suggestedParams,
          note,
          lease,
        });

  const signedTxn = txn.signTxn(masterAccount.sk);
  const txId = txn.txID();

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await algodClient.sendRawTransaction(signedTxn).do();
      await algosdk.waitForConfirmation(algodClient, txId, 10);
      return { txId, alreadyDistributed: false };
    } catch (error) {
      lastError = error;
      // The send may have failed because the txn already confirmed (a prior
      // attempt landed, or "transaction already in ledger"). Re-confirm the
      // exact txid before deciding to retry.
      try {
        await algosdk.waitForConfirmation(algodClient, txId, 3);
        return { txId, alreadyDistributed: false };
      } catch {
        // Still not in the ledger — fall through to retry.
      }
      if (attempt < 2) {
        console.warn(`[lootbox-distributor] Attempt ${attempt + 1} failed, retrying...`, error);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  throw lastError;
}
