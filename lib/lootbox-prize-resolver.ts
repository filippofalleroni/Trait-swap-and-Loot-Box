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
  // Filter out prizes with non-positive weights (defensive against
  // malformed data loaded from blob storage bypassing admin validation).
  const validPrizes = prizes.filter(function (p) {
    return p.weight > 0;
  });

  if (validPrizes.length === 0) {
    throw new Error("Cannot resolve a prize from an empty prize list.");
  }

  const totalWeight = validPrizes.reduce(function (sum, p) {
    return sum + p.weight;
  }, 0);

  if (totalWeight <= 0) {
    throw new Error("Total prize weight must be greater than zero.");
  }

  // Normalize the random value into the weight range, handling values
  // outside [0, 1) safely via modulo (mirrors production behavior with
  // on-chain randomness beacons that may yield arbitrary integers).
  const bounded =
    ((randomValue * totalWeight) % totalWeight + totalWeight) % totalWeight;
  let cumulative = 0;

  for (let i = 0; i < validPrizes.length; i++) {
    cumulative += validPrizes[i].weight;
    if (bounded < cumulative) {
      return validPrizes[i];
    }
  }

  // Fallback: return the last prize (handles floating-point edge cases)
  return validPrizes[validPrizes.length - 1];
}

/**
 * Calculate the percentage odds for each prize tier.
 *
 * Useful for displaying prize probabilities in the UI.
 *
 * @param prizes - Array of prize tiers with weight values
 * @returns Each prize tier augmented with a `chance` field (percentage, 2 decimal places)
 */
export function getPrizeOdds(
  prizes: PrizeTier[]
): Array<PrizeTier & { chance: number }> {
  const totalWeight = prizes.reduce(function (sum, p) {
    return sum + p.weight;
  }, 0);

  return prizes.map(function (prize) {
    return {
      ...prize,
      chance:
        totalWeight > 0
          ? Math.round((prize.weight / totalWeight) * 10000) / 100
          : 0,
    };
  });
}
