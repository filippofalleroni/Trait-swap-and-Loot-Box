/**
 * Format a micro-ALGO amount as a human-readable ALGO string.
 *
 * @example
 * formatAlgo(1_500_000) // => "1.5"
 * formatAlgo(10_000_000) // => "10"
 */
export function formatAlgo(microAlgos: number): string {
  const algos = microAlgos / 1_000_000;
  // Remove unnecessary trailing zeros
  return algos % 1 === 0 ? algos.toFixed(0) : algos.toFixed(6).replace(/0+$/, "");
}

/**
 * Shorten an Algorand address for display purposes.
 *
 * @example
 * shortenAddress("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX")
 * // => "ABCDEF...UVWX"
 */
export function shortenAddress(addr: string, chars = 6): string {
  if (!addr) return "";
  if (addr.length <= chars * 2) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}
