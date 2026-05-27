export type TraitCategory = string;

export type OfficialTraitCategory =
  | "BACKGROUND"
  | "BODY"
  | "COMPANION"
  | "EYES"
  | "MOUTH"
  | "SKIN"
  | "TOP";

export type TraitRarity = "Common" | "Rare" | "Epic" | "Legendary";

export type Trait = {
  id: string;
  name: string;
  category: TraitCategory;
  rarity: TraitRarity;
  priceAlgo: number;
  imageUrl: string;
  description: string;
  assetId?: number;
};

export type CollectionNft = {
  id: string;
  name: string;
  imageUrl: string;
  traits: string[];
  assetId?: number;
  unitName?: string;
  metadataUrl?: string;
  layers?: Partial<Record<OfficialTraitCategory, string>>;
  layerImageUrls?: Partial<Record<OfficialTraitCategory, string>>;
};

export type NftMetadata = {
  name: string;
  description: string;
  image: string;
  image_mimetype: "image/png";
  properties: Partial<Record<OfficialTraitCategory, string>>;
  external_url?: string;
};

export type TraitRegistryItem = {
  registryId: string;
  assetId?: number;
  /** Links this registry entry back to a mock trait id during development. */
  mockTraitId?: string;
  name: string;
  category: OfficialTraitCategory;
  rarity: TraitRarity;
  priceAlgo: number;
  metadataValue: string;
  imagePath: string;
  imageMimeType: "image/png";
  enabled: boolean;
  /**
   * "mock" = trait backed by mock data (development / preview).
   * "nft"  = trait backed by a real minted ASA on-chain.
   */
  source: "mock" | "nft";
};

export type PrizeType = "token" | "nft";
export type PrizeRarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export type PrizeTier = {
  id: string;
  name: string;
  type: PrizeType;
  assetId: number;
  amount: number;
  weight: number;
  rarity: PrizeRarity;
  color: string;
  imageUrl?: string;
};
