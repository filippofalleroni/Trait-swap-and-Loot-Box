import algosdk from "algosdk";

/**
 * Server-only module that loads the manager wallet from the
 * MANAGER_MNEMONIC environment variable.
 *
 * The manager account is used to sign asset-config transactions
 * (e.g., ARC-19 metadata updates) on behalf of the collection.
 *
 * WARNING: Never expose mnemonic-derived material to client components
 * or NEXT_PUBLIC_* environment variables. Keep all transaction signing
 * inside server routes/modules that import this file.
 */

function getManagerMnemonic(): string {
  const mnemonic = process.env.MANAGER_MNEMONIC?.trim() ?? "";

  if (!mnemonic) {
    throw new Error(
      "MANAGER_MNEMONIC environment variable is not set. " +
        "The manager wallet is required for signing transactions."
    );
  }

  return mnemonic;
}

export function getManagerAccount(): algosdk.Account {
  return algosdk.mnemonicToSecretKey(getManagerMnemonic());
}

/** Return the manager wallet's public Algorand address. */
export function getManagerAddress(): string {
  return getManagerAccount().addr.toString();
}

/** Check whether ARC-19 live on-chain updates are enabled. */
export function isLiveArc19UpdateEnabled(): boolean {
  return process.env.ARC19_LIVE_UPDATES_ENABLED?.trim() === "true";
}
