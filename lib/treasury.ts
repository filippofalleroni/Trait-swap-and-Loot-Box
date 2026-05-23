export function getTreasuryAddress(): string {
  const addr = process.env.TREASURY_ADDRESS?.trim();
  if (!addr) {
    throw new Error(
      "TREASURY_ADDRESS is not set. Add it to your .env.local file."
    );
  }
  return addr;
}
