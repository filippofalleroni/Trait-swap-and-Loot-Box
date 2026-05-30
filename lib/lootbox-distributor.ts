import algosdk from "algosdk";
import type { PrizeTier } from "./types";

/**
 * Server-only module for distributing loot box prizes.
 *
 * Sends the won prize (token transfer or NFT transfer) from the
 * master wallet to the winner's address.
 */

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
}: {
  prize: PrizeTier;
  recipientAddress: string;
  masterAccount: algosdk.Account;
  algodClient: algosdk.Algodv2;
}): Promise<string> {
  // Pre-flight balance check: verify the master wallet can cover the prize
  // masterAccount.addr is an Address object in algosdk v3; use .toString()
  // for string contexts to avoid implicit coercion issues.
  const masterAddr = masterAccount.addr.toString();
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

  const suggestedParams = await algodClient.getTransactionParams().do();

  // Include the prize ID in the transaction note for audit trail
  const note = new TextEncoder().encode(`lootbox-prize:${prize.id}`);

  let txn: algosdk.Transaction;

  if (prize.assetId === 0) {
    // ALGO prize — send a payment transaction (no opt-in needed)
    txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: masterAddr,
      receiver: recipientAddress,
      amount: prize.amount,
      suggestedParams,
      note,
    });
  } else {
    // ASA prize — verify opt-in, then send asset transfer
    await verifyRecipientOptedIn(algodClient, recipientAddress, prize.assetId);

    txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: masterAddr,
      receiver: recipientAddress,
      assetIndex: prize.assetId,
      amount: prize.type === "nft" ? 1 : prize.amount,
      suggestedParams,
      note,
    });
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sp = attempt === 0 ? suggestedParams : await algodClient.getTransactionParams().do();
      const retryTxn = attempt === 0 ? txn : (() => {
        if (prize.assetId === 0) {
          return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
            sender: masterAddr, receiver: recipientAddress, amount: prize.amount, suggestedParams: sp, note,
          });
        }
        return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender: masterAddr, receiver: recipientAddress, assetIndex: prize.assetId,
          amount: prize.type === "nft" ? 1 : prize.amount, suggestedParams: sp, note,
        });
      })();
      const signedTxn = retryTxn.signTxn(masterAccount.sk);
      const { txid } = await algodClient.sendRawTransaction(signedTxn).do();
      await algosdk.waitForConfirmation(algodClient, txid as string, 10);
      return txid as string;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        console.warn(`[lootbox-distributor] Attempt ${attempt + 1} failed, retrying...`, error);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  throw lastError;
}
