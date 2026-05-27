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
  const suggestedParams = await algodClient.getTransactionParams().do();

  // Include the prize ID in the transaction note for audit trail
  const note = new TextEncoder().encode(`lootbox-prize:${prize.id}`);

  let txn: algosdk.Transaction;

  if (prize.assetId === 0) {
    // ALGO prize — send a payment transaction (no opt-in needed)
    txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: masterAccount.addr,
      receiver: recipientAddress,
      amount: prize.amount,
      suggestedParams,
      note,
    });
  } else {
    // ASA prize — verify opt-in, then send asset transfer
    await verifyRecipientOptedIn(algodClient, recipientAddress, prize.assetId);

    txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: masterAccount.addr,
      receiver: recipientAddress,
      assetIndex: prize.assetId,
      amount: prize.type === "nft" ? 1 : prize.amount,
      suggestedParams,
      note,
    });
  }

  const signedTxn = txn.signTxn(masterAccount.sk);
  const { txid } = await algodClient.sendRawTransaction(signedTxn).do();

  // Wait for confirmation
  await algosdk.waitForConfirmation(algodClient, txid, 4);

  console.log(
    `[lootbox-distributor] Prize "${prize.name}" (${prize.type}) sent to ${recipientAddress} (txId: ${txid})`
  );

  return txid;
}
