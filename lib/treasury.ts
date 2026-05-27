import algosdk from "algosdk";

export function getTreasuryAddress(): string {
  const addr = process.env.TREASURY_ADDRESS?.trim();
  if (!addr) {
    throw new Error(
      "TREASURY_ADDRESS is not set. Add it to your .env.local file."
    );
  }
  if (!algosdk.isValidAddress(addr)) {
    throw new Error(
      "TREASURY_ADDRESS is not a valid Algorand address."
    );
  }
  return addr;
}
