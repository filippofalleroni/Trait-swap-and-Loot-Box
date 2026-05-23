import type { Trait, CollectionNft, OfficialTraitCategory } from "@/lib/types";

/**
 * Mock data for the trait swapper template.
 *
 * Replace this with real data from your collection's trait registry,
 * database, or IPFS metadata. These mocks allow the UI to function
 * out of the box for demonstration purposes.
 */

/* ------------------------------------------------------------------ */
/*  Mock Traits -- available traits that can be applied to NFTs       */
/* ------------------------------------------------------------------ */

export const mockTraits: Trait[] = [
  // BACKGROUND
  {
    id: "bg-sunset",
    name: "Sunset",
    category: "BACKGROUND",
    rarity: "Common",
    priceAlgo: 5,
    imageUrl: "/traits/BACKGROUND/Sunset.png",
    description: "A warm sunset gradient background.",
  },
  {
    id: "bg-ocean",
    name: "Ocean Blue",
    category: "BACKGROUND",
    rarity: "Common",
    priceAlgo: 5,
    imageUrl: "/traits/BACKGROUND/Ocean-Blue.png",
    description: "Deep blue ocean vibes.",
  },
  {
    id: "bg-nebula",
    name: "Cosmic Nebula",
    category: "BACKGROUND",
    rarity: "Epic",
    priceAlgo: 30,
    imageUrl: "/traits/BACKGROUND/Cosmic-Nebula.png",
    description: "A vibrant cosmic nebula background.",
  },
  {
    id: "bg-gold",
    name: "Gold",
    category: "BACKGROUND",
    rarity: "Legendary",
    priceAlgo: 50,
    imageUrl: "/traits/BACKGROUND/Gold.png",
    description: "Radiant gold shimmer background.",
  },

  // SKIN
  {
    id: "skin-blue",
    name: "Blue",
    category: "SKIN",
    rarity: "Common",
    priceAlgo: 5,
    imageUrl: "/traits/SKIN/Blue.png",
    description: "Cool blue skin tone.",
  },
  {
    id: "skin-crimson",
    name: "Crimson",
    category: "SKIN",
    rarity: "Rare",
    priceAlgo: 15,
    imageUrl: "/traits/SKIN/Crimson.png",
    description: "Deep crimson skin tone.",
  },
  {
    id: "skin-emerald",
    name: "Emerald",
    category: "SKIN",
    rarity: "Epic",
    priceAlgo: 30,
    imageUrl: "/traits/SKIN/Emerald.png",
    description: "Rich emerald green skin tone.",
  },

  // BODY
  {
    id: "body-armor",
    name: "Armor",
    category: "BODY",
    rarity: "Rare",
    priceAlgo: 20,
    imageUrl: "/traits/BODY/Armor.png",
    description: "Gleaming plate armor.",
  },
  {
    id: "body-hoodie",
    name: "Hoodie",
    category: "BODY",
    rarity: "Common",
    priceAlgo: 5,
    imageUrl: "/traits/BODY/Hoodie.png",
    description: "Classic comfortable hoodie.",
  },
  {
    id: "body-suit",
    name: "Suit",
    category: "BODY",
    rarity: "Epic",
    priceAlgo: 25,
    imageUrl: "/traits/BODY/Suit.png",
    description: "Sharp tailored suit.",
  },

  // EYES
  {
    id: "eyes-laser",
    name: "Laser",
    category: "EYES",
    rarity: "Legendary",
    priceAlgo: 50,
    imageUrl: "/traits/EYES/Laser.png",
    description: "Intense laser beam eyes.",
  },
  {
    id: "eyes-shades",
    name: "Shades",
    category: "EYES",
    rarity: "Common",
    priceAlgo: 5,
    imageUrl: "/traits/EYES/Shades.png",
    description: "Cool dark shades.",
  },
  {
    id: "eyes-cyber",
    name: "Cyber",
    category: "EYES",
    rarity: "Rare",
    priceAlgo: 15,
    imageUrl: "/traits/EYES/Cyber.png",
    description: "Cybernetic eye implants.",
  },

  // MOUTH
  {
    id: "mouth-grin",
    name: "Grin",
    category: "MOUTH",
    rarity: "Common",
    priceAlgo: 5,
    imageUrl: "/traits/MOUTH/Grin.png",
    description: "A wide playful grin.",
  },
  {
    id: "mouth-fangs",
    name: "Fangs",
    category: "MOUTH",
    rarity: "Rare",
    priceAlgo: 15,
    imageUrl: "/traits/MOUTH/Fangs.png",
    description: "Sharp vampire fangs.",
  },

  // TOP
  {
    id: "top-crown",
    name: "Golden Crown",
    category: "TOP",
    rarity: "Legendary",
    priceAlgo: 50,
    imageUrl: "/traits/TOP/Golden-Crown.png",
    description: "A golden crown fit for royalty.",
  },
  {
    id: "top-cap",
    name: "Baseball Cap",
    category: "TOP",
    rarity: "Common",
    priceAlgo: 3,
    imageUrl: "/traits/TOP/Baseball-Cap.png",
    description: "A classic baseball cap.",
  },
  {
    id: "top-hat",
    name: "Example Hat",
    category: "TOP",
    rarity: "Common",
    priceAlgo: 5,
    imageUrl: "/traits/TOP/Example-Hat.png",
    description: "A simple hat for your NFT.",
  },
  {
    id: "top-halo",
    name: "Halo",
    category: "TOP",
    rarity: "Epic",
    priceAlgo: 30,
    imageUrl: "/traits/TOP/Halo.png",
    description: "A radiant golden halo.",
  },

  // COMPANION
  {
    id: "companion-parrot",
    name: "Parrot",
    category: "COMPANION",
    rarity: "Rare",
    priceAlgo: 20,
    imageUrl: "/traits/COMPANION/Parrot.png",
    description: "A colorful parrot companion.",
  },
  {
    id: "companion-cat",
    name: "Cat",
    category: "COMPANION",
    rarity: "Common",
    priceAlgo: 10,
    imageUrl: "/traits/COMPANION/Cat.png",
    description: "A friendly cat sidekick.",
  },
];

/* ------------------------------------------------------------------ */
/*  Mock Owned NFTs -- placeholder NFTs for demo/testing              */
/* ------------------------------------------------------------------ */

export const mockOwnedNfts: CollectionNft[] = [
  {
    id: "nft-1",
    name: "Collection NFT #1234",
    imageUrl: "/placeholder-nft-1.png",
    traits: ["Sunset", "Blue", "Hoodie", "Shades", "Grin", "Example Hat"],
    assetId: 100000001,
    unitName: "NFT1234",
    layers: {
      BACKGROUND: "Sunset",
      SKIN: "Blue",
      BODY: "Hoodie",
      EYES: "Shades",
      MOUTH: "Grin",
      TOP: "Example Hat",
    },
    layerImageUrls: {
      BACKGROUND: "/traits/BACKGROUND/Sunset.png",
      SKIN: "/traits/SKIN/Blue.png",
      BODY: "/traits/BODY/Hoodie.png",
      EYES: "/traits/EYES/Shades.png",
      MOUTH: "/traits/MOUTH/Grin.png",
      TOP: "/traits/TOP/Example-Hat.png",
    },
  },
  {
    id: "nft-2",
    name: "Collection NFT #2567",
    imageUrl: "/placeholder-nft-2.png",
    traits: ["Ocean Blue", "Crimson", "Armor", "Cyber", "Fangs", "Golden Crown", "Parrot"],
    assetId: 100000002,
    unitName: "NFT2567",
    layers: {
      BACKGROUND: "Ocean Blue",
      SKIN: "Crimson",
      BODY: "Armor",
      EYES: "Cyber",
      MOUTH: "Fangs",
      TOP: "Golden Crown",
      COMPANION: "Parrot",
    },
    layerImageUrls: {
      BACKGROUND: "/traits/BACKGROUND/Ocean-Blue.png",
      SKIN: "/traits/SKIN/Crimson.png",
      BODY: "/traits/BODY/Armor.png",
      EYES: "/traits/EYES/Cyber.png",
      MOUTH: "/traits/MOUTH/Fangs.png",
      TOP: "/traits/TOP/Golden-Crown.png",
      COMPANION: "/traits/COMPANION/Parrot.png",
    },
  },
  {
    id: "nft-3",
    name: "Collection NFT #4891",
    imageUrl: "/placeholder-nft-3.png",
    traits: ["Cosmic Nebula", "Emerald", "Suit", "Laser", "Fangs", "Halo"],
    assetId: 100000003,
    unitName: "NFT4891",
    layers: {
      BACKGROUND: "Cosmic Nebula",
      SKIN: "Emerald",
      BODY: "Suit",
      EYES: "Laser",
      MOUTH: "Fangs",
      TOP: "Halo",
    },
    layerImageUrls: {
      BACKGROUND: "/traits/BACKGROUND/Cosmic-Nebula.png",
      SKIN: "/traits/SKIN/Emerald.png",
      BODY: "/traits/BODY/Suit.png",
      EYES: "/traits/EYES/Laser.png",
      MOUTH: "/traits/MOUTH/Fangs.png",
      TOP: "/traits/TOP/Halo.png",
    },
  },
];

/* ------------------------------------------------------------------ */
/*  Helper: look up a mock trait by ID                                */
/* ------------------------------------------------------------------ */

export function getMockTraitById(id: string): Trait | undefined {
  return mockTraits.find((t) => t.id === id);
}

/* ------------------------------------------------------------------ */
/*  Helper: get all traits for a given category                       */
/* ------------------------------------------------------------------ */

export function getMockTraitsByCategory(
  category: OfficialTraitCategory
): Trait[] {
  return mockTraits.filter((t) => t.category === category);
}
