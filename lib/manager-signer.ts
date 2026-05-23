import algosdk from "algosdk";

/**
 * Server-only module that loads the manager wallet from the
 * MANAGER_MNEMONIC environment variable.
 *
 * The manager account is used to sign asset-config transactions
 * (e.g., ARC-19 metadata updates) on behalf of the collection.
 */
export function getManagerAccount(): algosdk.Account {
  const mnemonic = process.env.MANAGER_MNEMONIC?.trim();

  if (!mnemonic) {
    throw new Error(
      "MANAGER_MNEMONIC environment variable is not set. " +
        "The manager wallet is required for signing transactions."
    );
  }

  return algosdk.mnemonicToSecretKey(mnemonic);
}
