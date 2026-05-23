import type { PrizeTier } from "./types";

/**
 * Weighted random prize selection.
 *
 * Given a list of prizes (each with a `weight` field) and a random value
 * between 0 and 1, returns the selected prize based on weight distribution.
 *
 * Higher weight = more likely to be selected.
 *
 * @param prizes - Array of prize tiers with weight values
 * @param randomValue - A random number in the range [0, 1)
 * @returns The selected prize tier
 *
 * @example
 * const prizes = [
 *   { id: "a", weight: 70, ... },  // 70% chance
 *   { id: "b", weight: 20, ... },  // 20% chance
 *   { id: "c", weight: 10, ... },  // 10% chance
 * ];
 * const winner = resolvePrize(prizes, Math.random());
 */
export function resolvePrize(
  prizes: PrizeTier[],
  randomValue: number
): PrizeTier {
  if (prizes.length === 0) {
    throw new Error("Cannot resolve a prize from an empty prize list.");
  }

  const totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);

  if (totalWeight <= 0) {
    throw new Error("Total prize weight must be greater than zero.");
  }

  const target = randomValue * totalWeight;
  let cumulative = 0;

  for (const prize of prizes) {
    cumulative += prize.weight;
    if (target < cumulative) {
      return prize;
    }
  }

  // Fallback: return the last prize (handles floating-point edge cases)
  return prizes[prizes.length - 1];
}
