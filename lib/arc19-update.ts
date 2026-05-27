import algosdk from "algosdk";
import { CID } from "multiformats/cid";
import { getAlgodClient, INDEXER_BASE_URL } from "./algorand";

/**
 * Server-only helper for updating ARC-19 metadata pointers.
 *
 * ARC-19 stores the IPFS CID as the asset's reserve address.
 * Updating the reserve address effectively updates the on-chain
 * metadata pointer without needing a new asset.
 */

const ZERO_ADDRESS =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";

type IndexerAssetConfigResponse = {
  asset?: {
    index: number;
    params: {
      creator?: string;
      manager?: string;
      reserve?: string;
      freeze?: string;
      clawback?: string;
      url?: string;
    };
  };
};

/**
 * Fetch the current on-chain asset configuration from the indexer.
 * Returns null if the asset cannot be found.
 */
async function fetchAssetConfig(assetId: number) {
  const response = await fetch(`${INDEXER_BASE_URL}/v2/assets/${assetId}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Indexer asset request failed for ${assetId} with status ${response.status}`
    );
  }

  const data = (await response.json()) as IndexerAssetConfigResponse;
  return data.asset ?? null;
}

/**
 * Convert an IPFS CID (v0 or v1) into an Algorand address that encodes
 * the CID's multihash digest. This is the ARC-19 convention for storing
 * metadata pointers on-chain.
 */
export function computeArc19ReserveAddress(cid: string): string {
  const parsed = CID.parse(cid);
  // The multihash digest is the raw 32-byte SHA-256 hash
  const digest = parsed.multihash.digest;

  if (digest.byteLength !== 32) {
    throw new Error(
      `CID ${cid} does not use a 32-byte multihash digest required for ARC-19 reserve encoding.`
    );
  }

  return algosdk.encodeAddress(digest);
}

/**
 * Prepare an unsigned ARC-19 asset-config transaction that updates the
 * reserve address. The caller can then sign and submit the transaction
 * via {@link signAndSubmitArc19Update}.
 *
 * Validates:
 * - The asset exists on-chain
 * - The asset has a manager address
 * - The configured manager matches the on-chain manager
 * - Freeze / clawback addresses are correctly preserved
 *
 * Optionally validates the asset creator when COLLECTION_CREATOR_ADDRESS
 * is set, preventing accidental updates to assets outside your collection.
 */
export async function prepareArc19UpdateTransaction({
  assetId,
  metadataCid,
  managerAddress,
}: {
  assetId: number;
  metadataCid: string;
  managerAddress: string;
}) {
  const asset = await fetchAssetConfig(assetId);
  if (!asset) {
    throw new Error(`Could not load current asset config for ${assetId}`);
  }

  // If a collection creator address is configured, verify the asset belongs
  // to the collection. This prevents updating assets you do not own.
  const expectedCreator = process.env.COLLECTION_CREATOR_ADDRESS?.trim();
  if (expectedCreator && asset.params.creator?.toLowerCase() !== expectedCreator.toLowerCase()) {
    throw new Error(
      `Asset ${assetId} creator ${asset.params.creator} does not match expected collection creator.`
    );
  }

  const currentManager = asset.params.manager ?? "";
  if (!currentManager) {
    throw new Error(`Asset ${assetId} has no manager address set.`);
  }

  if (currentManager.toLowerCase() !== managerAddress.toLowerCase()) {
    throw new Error(
      `Configured manager ${managerAddress} does not match asset manager ${currentManager} for asset ${assetId}.`
    );
  }

  const newReserveAddress = computeArc19ReserveAddress(metadataCid);
  const algodClient = getAlgodClient();
  const suggestedParams = await algodClient.getTransactionParams().do();

  // Preserve existing freeze/clawback addresses. Passing undefined for these
  // fields would CLEAR them permanently. We only pass the address if it is
  // set and is not the zero address.
  const freeze =
    asset.params.freeze && asset.params.freeze !== ZERO_ADDRESS
      ? asset.params.freeze
      : undefined;
  const clawback =
    asset.params.clawback && asset.params.clawback !== ZERO_ADDRESS
      ? asset.params.clawback
      : undefined;

  const txn = algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
    sender: managerAddress,
    assetIndex: assetId,
    manager: currentManager,
    reserve: newReserveAddress,
    freeze,
    clawback,
    suggestedParams,
    strictEmptyAddressChecking: false,
  });

  const encodedUnsignedTxn = Buffer.from(
    algosdk.encodeUnsignedTransaction(txn)
  ).toString("base64");

  return {
    assetId,
    managerAddress,
    currentReserveAddress: asset.params.reserve ?? null,
    newReserveAddress,
    currentArc19Template: asset.params.url ?? null,
    txId: txn.txID(),
    unsignedTxnBase64: encodedUnsignedTxn,
  };
}

/**
 * Sign and submit a previously prepared ARC-19 update transaction.
 *
 * Only runs when the ARC19_LIVE_UPDATES_ENABLED env var is set to "true".
 * Validates that the transaction is an asset-config type before signing.
 */
export async function signAndSubmitArc19Update({
  unsignedTxnBase64,
  secretKey,
}: {
  unsignedTxnBase64: string;
  secretKey: Uint8Array;
}): Promise<{ txId: string; confirmedRound: number | null } | null> {
  if (process.env.ARC19_LIVE_UPDATES_ENABLED !== "true") {
    console.log(
      "[arc19-update] Live updates disabled. Skipping transaction submission."
    );
    return null;
  }

  const unsignedTxnBytes = Buffer.from(unsignedTxnBase64, "base64");
  const txn = algosdk.decodeUnsignedTransaction(unsignedTxnBytes);

  // Safety check: only sign asset config transactions
  if (txn.type !== algosdk.TransactionType.acfg) {
    throw new Error(
      "Manager signer will only sign asset config transactions."
    );
  }

  const signedTxn = txn.signTxn(secretKey);
  const txId = txn.txID();

  const algodClient = getAlgodClient();
  const submission = await algodClient.sendRawTransaction(signedTxn).do();
  const confirmation = await algosdk.waitForConfirmation(algodClient, txId, 4);

  const confirmedRound =
    confirmation.confirmedRound != null
      ? Number(confirmation.confirmedRound)
      : null;

  console.log(
    `[arc19-update] Asset config updated (txId: ${txId}, round: ${confirmedRound})`
  );

  return {
    txId: String(submission.txid ?? txId),
    confirmedRound,
  };
}

/**
 * Convenience wrapper: prepare, sign, and submit an ARC-19 metadata update
 * in a single call. Returns null when live updates are disabled.
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
  const asset = await fetchAssetConfig(assetId);

  if (!asset) {
    throw new Error(`Could not load asset config for ${assetId}`);
  }

  const expectedCreator = process.env.COLLECTION_CREATOR_ADDRESS?.trim();
  if (expectedCreator && asset.params.creator?.toLowerCase() !== expectedCreator.toLowerCase()) {
    throw new Error(
      `Asset ${assetId} creator ${asset.params.creator} does not match expected collection creator.`
    );
  }

  const currentManager = asset.params.manager ?? "";
  if (!currentManager) {
    throw new Error(`Asset ${assetId} has no manager address set.`);
  }
  if (currentManager.toLowerCase() !== managerAccount.addr.toString().toLowerCase()) {
    throw new Error(
      `Configured manager does not match asset manager ${currentManager} for asset ${assetId}.`
    );
  }

  // Preserve existing freeze/clawback addresses
  const freeze =
    asset?.params.freeze && asset.params.freeze !== ZERO_ADDRESS
      ? asset.params.freeze
      : undefined;
  const clawback =
    asset?.params.clawback && asset.params.clawback !== ZERO_ADDRESS
      ? asset.params.clawback
      : undefined;

  const suggestedParams = await algodClient.getTransactionParams().do();

  const txn = algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
    sender: managerAccount.addr,
    assetIndex: assetId,
    suggestedParams,
    manager: managerAccount.addr,
    reserve: newReserveAddress,
    freeze,
    clawback,
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
