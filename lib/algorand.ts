import algosdk from "algosdk";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { create as createDigest } from "multiformats/hashes/digest";

// dag-pb codec code — avoids importing the entire @ipld/dag-pb package
const DAG_PB_CODE = 0x70;

// ---------------------------------------------------------------------------
// Node / Indexer clients
// ---------------------------------------------------------------------------

export const ALGOD_BASE_URL =
  process.env.NEXT_PUBLIC_ALGOD_URL?.trim() ||
  "https://mainnet-api.4160.nodely.dev";

// Empty token — public Nodely endpoints require no API key.
// Replace with your API token if using a private node.
export function getAlgodClient() {
  return new algosdk.Algodv2("", ALGOD_BASE_URL, "");
}

export const INDEXER_BASE_URL =
  process.env.NEXT_PUBLIC_INDEXER_URL?.trim() ||
  "https://mainnet-idx.4160.nodely.dev";

export function getIndexerClient() {
  return new algosdk.Indexer("", INDEXER_BASE_URL, "");
}

// ---------------------------------------------------------------------------
// Generic fetch helper
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed request for ${url}: ${response.status}`);
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// ARC-19 URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an asset URL to an HTTPS gateway URL.
 *
 * Handles three URL forms:
 *  - `ipfs://CID...` - simple IPFS gateway redirect
 *  - `template-ipfs://{ipfscid:VERSION:CODEC:reserve:sha2-256}SUFFIX` - ARC-19
 *  - `https://...` / `http://...` - passthrough
 *
 * @param url   The asset's `url` field from the indexer
 * @param reserve  The asset's `reserve` address (needed for ARC-19 templates)
 * @param gateway  IPFS gateway base URL (defaults to Pinata public gateway)
 */
export function resolveArc19Url(
  url: string | undefined,
  reserve: string | undefined,
  gateway = "https://gateway.pinata.cloud/ipfs/"
): string | null {
  if (!url) return null;

  if (url.startsWith("ipfs://")) {
    return `${gateway}${url.slice("ipfs://".length)}`;
  }

  const arc19Match = url.match(
    /^template-ipfs:\/\/\{ipfscid:(\d+):(raw|dag-pb):reserve:sha2-256\}(.*)$/
  );
  if (arc19Match && reserve) {
    const version = Number(arc19Match[1]);
    const codec = arc19Match[2];
    const publicKey = algosdk.decodeAddress(reserve).publicKey;
    const reserveDigest = createDigest(0x12, publicKey);
    const codecCode = codec === "dag-pb" ? DAG_PB_CODE : raw.code;
    const cid =
      version === 0
        ? CID.createV0(reserveDigest).toString()
        : CID.createV1(codecCode, reserveDigest).toString();
    const suffix = arc19Match[3] ?? "";
    return `${gateway}${cid}${suffix}`;
  }

  if (url.startsWith("https://")) return url;
  if (url.startsWith("http://")) return null;

  return null;
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

/** Return true if `address` is a syntactically valid Algorand address. */
export function isValidAlgorandAddress(address: string): boolean {
  try {
    algosdk.decodeAddress(address);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Account asset helpers
// ---------------------------------------------------------------------------

type IndexerAccountAssetsResponse = {
  assets?: Array<{
    amount: number;
    "asset-id": number;
    deleted?: boolean;
    frozen?: boolean;
    "is-frozen"?: boolean;
  }>;
};

/** Verify that `walletAddress` currently holds a non-zero balance of `assetId`. */
export async function verifyWalletOwnsAsset(
  walletAddress: string,
  assetId: number
): Promise<void> {
  const holdings = await fetchJson<IndexerAccountAssetsResponse>(
    `${INDEXER_BASE_URL}/v2/accounts/${walletAddress}/assets?asset-id=${assetId}&limit=1`
  );
  const holding = holdings.assets?.find(
    (a) => a["asset-id"] === assetId && a.amount > 0 && !a.deleted
  );
  if (!holding) {
    throw new Error(
      `Wallet ${walletAddress} does not hold asset ${assetId}.`
    );
  }
}

// ---------------------------------------------------------------------------
// Transaction verification
// ---------------------------------------------------------------------------

type IndexerTransactionResponse = {
  transaction?: {
    id?: string;
    "confirmed-round"?: number;
    "round-time"?: number;
    note?: string;
    group?: string;
    "rekey-to"?: string;
    "payment-transaction"?: {
      amount?: number;
      receiver?: string;
      "close-remainder-to"?: string;
    };
    "asset-transfer-transaction"?: {
      amount?: number;
      receiver?: string;
      "asset-id"?: number;
      "close-to"?: string;
    };
    sender?: string;
  };
};

/** Maximum age of a transaction (in seconds) before it is considered stale. */
const MAX_TX_AGE_SECONDS = 300;

/**
 * Verify a payment (ALGO) transaction on the indexer.
 *
 * Retries for up to ~60 s to allow the indexer time to index the confirmed tx.
 *
 * Checks performed:
 * - Transaction is confirmed
 * - Transaction is a payment type
 * - No rekeyTo or closeRemainderTo fields (prevents malicious piggy-backing)
 * - Sender / receiver match expected values
 * - Amount meets minimum
 * - Optional note prefix check
 * - Optional atomic group verification
 * - Transaction age within 5 minutes
 */
export async function verifyPaymentTransaction(
  txId: string,
  expectedSender: string,
  expectedReceiver: string,
  minMicroAlgo: number,
  expectedNotePrefix?: string,
  options?: {
    requireGroup?: boolean;
    verifyGroupPayment?: { receiver: string; minAmount: number };
  }
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const data = await fetchJson<IndexerTransactionResponse>(
        `${INDEXER_BASE_URL}/v2/transactions/${txId}`
      );
      const tx = data.transaction;

      if (!tx || !tx["confirmed-round"]) {
        throw new Error("not confirmed yet");
      }

      const payment = tx["payment-transaction"];

      if (!payment) {
        throw new Error("Transaction is not a payment transaction.");
      }
      if (tx["rekey-to"]) {
        throw new Error(
          "Transaction contains a rekeyTo field and is rejected."
        );
      }
      if (payment["close-remainder-to"]) {
        throw new Error(
          "Transaction contains a closeRemainderTo field and is rejected."
        );
      }
      if (tx.sender?.toLowerCase() !== expectedSender.toLowerCase()) {
        throw new Error("Payment sender does not match connected wallet.");
      }
      if (payment.receiver?.toLowerCase() !== expectedReceiver.toLowerCase()) {
        throw new Error(
          "Payment receiver does not match treasury address."
        );
      }
      if ((payment.amount ?? 0) < minMicroAlgo) {
        throw new Error(
          `Payment amount ${payment.amount} is less than required ${minMicroAlgo} microAlgo.`
        );
      }
      if (expectedNotePrefix) {
        const noteText = tx.note
          ? Buffer.from(tx.note, "base64").toString("utf-8")
          : "";
        if (!noteText.startsWith(expectedNotePrefix)) {
          throw new Error(
            "Transaction note does not match expected payment type."
          );
        }
      }

      if (options?.requireGroup && !tx.group) {
        throw new Error("Transaction must be part of an atomic group.");
      }

      // Reject transactions older than 5 minutes to prevent replay attacks
      const roundTime = tx["round-time"];
      if (roundTime == null || roundTime === 0) {
        throw new Error(
          "Transaction is missing timestamp. Please try again."
        );
      }
      const txAge = Math.floor(Date.now() / 1000) - roundTime;
      if (txAge > MAX_TX_AGE_SECONDS) {
        throw new Error(
          "Transaction is too old. Please submit a new payment."
        );
      }

      // Verify a required companion payment exists in the same atomic group
      if (options?.verifyGroupPayment && tx.group) {
        if (!tx.id) {
          throw new Error("Transaction missing ID field from indexer.");
        }
        const groupData = await fetchJson<{
          transactions?: Array<
            IndexerTransactionResponse["transaction"]
          >;
        }>(
          `${INDEXER_BASE_URL}/v2/transactions?group-id=${encodeURIComponent(tx.group)}&limit=16`
        );
        const groupTxns = groupData.transactions ?? [];
        const companionFound = groupTxns.some(function (gtx) {
          if (!gtx || gtx.id === tx.id) return false;
          const gPayment = gtx["payment-transaction"];
          if (!gPayment) return false;
          return (
            gPayment.receiver?.toLowerCase() ===
              options.verifyGroupPayment!.receiver.toLowerCase() &&
            (gPayment.amount ?? 0) >=
              options.verifyGroupPayment!.minAmount &&
            gtx.sender?.toLowerCase() === expectedSender.toLowerCase()
          );
        });
        if (!companionFound) {
          throw new Error(
            "Required companion payment not found in transaction group."
          );
        }
      }

      return;
    } catch (error) {
      if (
        error instanceof Error &&
        !error.message.includes("not confirmed yet") &&
        !error.message.includes("Failed request") &&
        !error.message.includes("missing timestamp")
      ) {
        throw error;
      }
    }

    await new Promise(function (resolve) {
      setTimeout(resolve, 3000);
    });
  }

  throw new Error(
    "Payment transaction could not be confirmed on the indexer. Please try again."
  );
}

/**
 * Verify an ASA (asset) transfer transaction on the indexer.
 *
 * Retries for up to ~60 s to allow the indexer time to index the confirmed tx.
 *
 * Checks performed:
 * - Transaction is confirmed
 * - Transaction is an asset transfer type
 * - No rekeyTo or closeTo fields
 * - Sender / receiver / asset ID match
 * - Amount meets minimum
 * - Optional note prefix check
 * - Transaction age within 5 minutes
 */
export async function verifyAsaPaymentTransaction(
  txId: string,
  expectedSender: string,
  expectedReceiver: string,
  expectedAssetId: number,
  minAmount: number,
  expectedNotePrefix?: string
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const data = await fetchJson<IndexerTransactionResponse>(
        `${INDEXER_BASE_URL}/v2/transactions/${txId}`
      );
      const tx = data.transaction;

      if (!tx || !tx["confirmed-round"]) {
        throw new Error("not confirmed yet");
      }

      const asaTransfer = tx["asset-transfer-transaction"];
      if (!asaTransfer) {
        throw new Error(
          "Transaction is not an asset transfer transaction."
        );
      }
      if (tx["rekey-to"]) {
        throw new Error(
          "Transaction contains a rekeyTo field and is rejected."
        );
      }
      if (asaTransfer["close-to"]) {
        throw new Error(
          "Transaction contains a closeTo field and is rejected."
        );
      }
      if (tx.sender?.toLowerCase() !== expectedSender.toLowerCase()) {
        throw new Error("Payment sender does not match connected wallet.");
      }
      if (
        asaTransfer.receiver?.toLowerCase() !==
        expectedReceiver.toLowerCase()
      ) {
        throw new Error(
          "Payment receiver does not match treasury address."
        );
      }
      if (asaTransfer["asset-id"] !== expectedAssetId) {
        throw new Error(
          `Payment asset ID ${asaTransfer["asset-id"]} does not match expected ${expectedAssetId}.`
        );
      }
      if ((asaTransfer.amount ?? 0) < minAmount) {
        throw new Error(
          `Payment amount ${asaTransfer.amount} is less than required ${minAmount}.`
        );
      }
      if (expectedNotePrefix) {
        const noteText = tx.note
          ? Buffer.from(tx.note, "base64").toString("utf-8")
          : "";
        if (!noteText.startsWith(expectedNotePrefix)) {
          throw new Error(
            "Transaction note does not match expected payment type."
          );
        }
      }

      const roundTime = tx["round-time"];
      if (roundTime == null || roundTime === 0) {
        throw new Error(
          "Transaction is missing timestamp. Please try again."
        );
      }
      const txAge = Math.floor(Date.now() / 1000) - roundTime;
      if (txAge > MAX_TX_AGE_SECONDS) {
        throw new Error(
          "Transaction is too old. Please submit a new payment."
        );
      }

      return;
    } catch (error) {
      if (
        error instanceof Error &&
        !error.message.includes("not confirmed yet") &&
        !error.message.includes("Failed request") &&
        !error.message.includes("missing timestamp")
      ) {
        throw error;
      }
    }

    await new Promise(function (resolve) {
      setTimeout(resolve, 3000);
    });
  }

  throw new Error(
    "Payment transaction could not be confirmed on the indexer. Please try again."
  );
}
