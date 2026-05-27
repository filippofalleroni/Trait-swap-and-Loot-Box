import algosdk from "algosdk";

/**
 * Server-only module that loads the loot box master wallet from the
 * LOOTBOX_MASTER_MNEMONIC environment variable.
 *
 * The master wallet holds the prize pool assets (tokens and NFTs)
 * and is used to distribute prizes to winners.
 */

function getLootboxMasterMnemonic(): string {
  const mnemonic = process.env.LOOTBOX_MASTER_MNEMONIC?.trim() ?? "";

  if (!mnemonic) {
    throw new Error(
      "LOOTBOX_MASTER_MNEMONIC environment variable is not set. " +
        "The loot box master wallet is required for prize distribution."
    );
  }

  return mnemonic;
}

export function getLootboxMasterAccount(): algosdk.Account {
  return algosdk.mnemonicToSecretKey(getLootboxMasterMnemonic());
}

/** Return the master wallet's public Algorand address. */
export function getLootboxMasterAddress(): string {
  return getLootboxMasterAccount().addr.toString();
}
