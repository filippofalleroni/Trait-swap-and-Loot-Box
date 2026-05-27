// ============================================================
// CUSTOMIZE THIS FILE for your NFT collection
// ============================================================

// The Algorand Standard Asset (ASA) creator address for your collection.
// Used to identify which NFTs in a wallet belong to your collection.
// Replace with your actual creator address before going live.
export const COLLECTION_CREATOR_ADDRESS = "YOUR_COLLECTION_CREATOR_ADDRESS";

// ARC-69 or ARC-19 unit name prefix (e.g., "MONSTR", "MYPROJECT")
export const COLLECTION_UNIT_PREFIX = "NFT";

// The number of NFTs in your collection (used for display only)
export const COLLECTION_SIZE = 5000;

// Base URL for trait layer images stored on IPFS (Pinata, NFT.storage, etc.)
// Example: "https://gateway.pinata.cloud/ipfs/YOUR_CID_HERE"
// Leave empty if you serve trait images from /public instead of IPFS.
export const TRAIT_IMAGE_BASE_URL = "";

// The ordered list of trait layer categories your collection uses.
// These must match the ARC-69 metadata property keys exactly.
// Layers are composited in this order (first = bottom, last = top).
export const OFFICIAL_TRAIT_CATEGORIES = [
  "BACKGROUND",
  "BODY",
  "COMPANION",
  "EYES",
  "MOUTH",
  "SKIN",
  "TOP",
] as const;
