import algosdk from "algosdk";
import { CID } from "multiformats/cid";
import { getAlgodClient } from "./algorand";

/**
 * Server-only helper for updating ARC-19 metadata pointers.
 *
 * ARC-19 stores the IPFS CID as the asset's reserve address.
 * Updating the reserve address effectively updates the on-chain
 * metadata pointer without needing a new asset.
 */

/**
 * Convert an IPFS CID (v0 or v1) into an Algorand address that encodes
 * the CID's multihash digest. This is the ARC-19 convention for storing
 * metadata pointers on-chain.
 */
export function computeArc19ReserveAddress(cid: string): string {
  const parsed = CID.parse(cid);
  // The multihash digest is the raw 32-byte SHA-256 hash
  const digest = parsed.multihash.digest;

  if (digest.length !== 32) {
    throw new Error(
      `Expected a 32-byte digest for ARC-19 reserve address, got ${digest.length} bytes.`
    );
  }

  return algosdk.encodeAddress(digest);
}

/**
 * Update an asset's reserve address to point to new ARC-19 metadata.
 *
 * Only runs when the ARC19_LIVE_UPDATES_ENABLED env var is set to "true".
 */
export async function updateArc19Metadata({
  assetId,
  newReserveAddress,
  managerAccount,
}: {
  assetId: number;
  newReserveAddress: string;
  managerAccount: algosdk.Account;
}): Promise<string | null> {
  if (process.env.ARC19_LIVE_UPDATES_ENABLED !== "true") {
    console.log(
      `[arc19-update] Live updates disabled. Skipping reserve update for asset ${assetId}.`
    );
    return null;
  }

  const algodClient = getAlgodClient();
  const suggestedParams = await algodClient.getTransactionParams().do();

  // Build an asset config transaction that only changes the reserve address.
  // All other fields (manager, freeze, clawback) are preserved by passing
  // undefined — algosdk will keep the existing values.
  const txn = algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
    sender: managerAccount.addr,
    assetIndex: assetId,
    suggestedParams,
    manager: managerAccount.addr,
    reserve: newReserveAddress,
    freeze: undefined,
    clawback: undefined,
    strictEmptyAddressChecking: false,
  });

  const signedTxn = txn.signTxn(managerAccount.sk);
  const { txid } = await algodClient.sendRawTransaction(signedTxn).do();

  // Wait for confirmation
  await algosdk.waitForConfirmation(algodClient, txid, 4);

  console.log(
    `[arc19-update] Asset ${assetId} reserve updated to ${newReserveAddress} (txId: ${txid})`
  );

  return txid;
}
