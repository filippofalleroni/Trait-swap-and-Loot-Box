import type { OfficialTraitCategory } from "./types";

/**
 * The rendering order for NFT trait layers.
 * Layers are composited from bottom (first) to top (last).
 */
export const LAYER_ORDER: OfficialTraitCategory[] = [
  "BACKGROUND",
  "SKIN",
  "BODY",
  "EYES",
  "MOUTH",
  "TOP",
  "COMPANION",
];

const OFFICIAL_CATEGORIES = new Set<string>(LAYER_ORDER);

/**
 * Type guard that checks whether a string is a valid OfficialTraitCategory.
 */
export function isOfficialTraitCategory(
  val: string
): val is OfficialTraitCategory {
  return OFFICIAL_CATEGORIES.has(val);
}

/**
 * Sanitize a trait name for use in URL paths.
 * Removes path traversal sequences and unsafe characters.
 */
function sanitizeTraitName(name: string): string {
  // Remove path traversal sequences and null bytes
  return name
    .replace(/\.\./g, "")
    .replace(/[/\\:\0]/g, "")
    .trim();
}

/**
 * Returns the canonical image URL for a trait layer.
 *
 * @example
 * getTraitLayerImageUrl("TOP", "Example-Hat")
 * // => "/traits/TOP/Example-Hat.png"
 */
export function getTraitLayerImageUrl(
  category: OfficialTraitCategory,
  traitName: string
): string {
  const safeName = sanitizeTraitName(traitName);
  return `/traits/${category}/${safeName}.png`;
}

/**
 * Returns an array of candidate image URLs for a trait layer,
 * useful for fallback loading strategies.
 *
 * Each candidate includes a `src` URL and a `key` for identification.
 */
export function getTraitLayerImageCandidates(
  category: OfficialTraitCategory,
  traitName: string
): { src: string; key: string }[] {
  const safeName = sanitizeTraitName(traitName);
  return [
    {
      src: `/traits/${category}/${safeName}.png`,
      key: `${category}-${safeName}-png`,
    },
    {
      src: `/traits/${category}/${safeName.toLowerCase()}.png`,
      key: `${category}-${safeName}-lower-png`,
    },
    {
      src: `/traits/${category}/${safeName.replace(/ /g, "-")}.png`,
      key: `${category}-${safeName}-dashed-png`,
    },
    {
      src: `/traits/${category}/${safeName.replace(/ /g, "_")}.png`,
      key: `${category}-${safeName}-underscored-png`,
    },
  ];
}
