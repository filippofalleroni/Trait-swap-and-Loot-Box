import algosdk from "algosdk";

export const ALGOD_BASE_URL =
  process.env.NEXT_PUBLIC_ALGOD_URL?.trim() || "https://mainnet-api.4160.nodely.dev";

// Empty token — public Nodely endpoints require no API key.
// Replace with your API token if using a private node.
export function getAlgodClient() {
  return new algosdk.Algodv2("", ALGOD_BASE_URL, "");
}

export const INDEXER_BASE_URL =
  process.env.NEXT_PUBLIC_INDEXER_URL?.trim() || "https://mainnet-idx.4160.nodely.dev";

export function getIndexerClient() {
  return new algosdk.Indexer("", INDEXER_BASE_URL, "");
}
