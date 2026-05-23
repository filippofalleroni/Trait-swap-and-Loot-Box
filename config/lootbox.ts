import type { PrizeTier, PrizeRarity } from "@/lib/types";

export const RARITY_COLORS: Record<PrizeRarity, string> = {
  common: "#9ca3af",
  uncommon: "#4ade80",
  rare: "#60a5fa",
  epic: "#c084fc",
  legendary: "#fbbf24",
};

// ============================================================
// CUSTOMIZE: Configure your loot box prizes here.
// Each prize needs: id, name, type (token/nft), assetId (ASA ID),
// amount, weight (higher = more common), rarity, and color.
// ============================================================
export const lootboxConfig = {
  cratePrice: 10,
  cratePriceMicroAlgo: 10_000_000,
  commitDelayRounds: 8,
  randomnessBeaconAppId: 947461882,

  prizes: [
    {
      id: "token-500",
      name: "500 Tokens",
      type: "token" as const,
      assetId: 0, // <-- Replace with your token's ASA ID
      amount: 500,
      weight: 30,
      rarity: "common" as const,
      color: "#4ade80",
    },
    {
      id: "token-1000",
      name: "1,000 Tokens",
      type: "token" as const,
      assetId: 0,
      amount: 1000,
      weight: 20,
      rarity: "common" as const,
      color: "#4ade80",
    },
    {
      id: "token-5000",
      name: "5,000 Tokens",
      type: "token" as const,
      assetId: 0,
      amount: 5000,
      weight: 10,
      rarity: "uncommon" as const,
      color: "#4ade80",
    },
    {
      id: "token-25000",
      name: "25,000 Tokens",
      type: "token" as const,
      assetId: 0,
      amount: 25000,
      weight: 5,
      rarity: "rare" as const,
      color: "#60a5fa",
    },
    {
      id: "token-100000",
      name: "100,000 Tokens",
      type: "token" as const,
      assetId: 0,
      amount: 100000,
      weight: 2,
      rarity: "epic" as const,
      color: "#c084fc",
    },
  ] as PrizeTier[],
};

export const totalPrizeWeight = lootboxConfig.prizes.reduce((sum, p) => sum + p.weight, 0);
