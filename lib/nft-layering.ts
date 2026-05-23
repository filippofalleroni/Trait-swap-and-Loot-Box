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
  return `/traits/${category}/${traitName}.png`;
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
  return [
    {
      src: `/traits/${category}/${traitName}.png`,
      key: `${category}-${traitName}-png`,
    },
    {
      src: `/traits/${category}/${traitName.toLowerCase()}.png`,
      key: `${category}-${traitName}-lower-png`,
    },
    {
      src: `/traits/${category}/${traitName.replace(/ /g, "-")}.png`,
      key: `${category}-${traitName}-dashed-png`,
    },
    {
      src: `/traits/${category}/${traitName.replace(/ /g, "_")}.png`,
      key: `${category}-${traitName}-underscored-png`,
    },
  ];
}
