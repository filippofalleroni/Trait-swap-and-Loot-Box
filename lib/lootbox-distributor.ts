import algosdk from "algosdk";
import type { PrizeTier } from "./types";

/**
 * Server-only module for distributing loot box prizes.
 *
 * Sends the won prize (token transfer or NFT transfer) from the
 * master wallet to the winner's address.
 */
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

  let txn: algosdk.Transaction;

  if (prize.type === "token") {
    // ASA token transfer
    txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: masterAccount.addr,
      receiver: recipientAddress,
      assetIndex: prize.assetId,
      amount: prize.amount,
      suggestedParams,
    });
  } else if (prize.type === "nft") {
    // NFT transfer (amount is always 1 for NFTs)
    txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: masterAccount.addr,
      receiver: recipientAddress,
      assetIndex: prize.assetId,
      amount: 1,
      suggestedParams,
    });
  } else {
    throw new Error(`Unknown prize type: ${prize.type}`);
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
