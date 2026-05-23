"use client";

import React, { useState } from "react";
import { LAYER_ORDER } from "@/lib/nft-layering";
import type { CollectionNft, OfficialTraitCategory } from "@/lib/types";

interface NftLayeredImageProps {
  nft: CollectionNft;
  /** Optional layer overrides for previewing trait changes */
  layerOverrides?: Partial<Record<OfficialTraitCategory, string | null>>;
  className?: string;
  size?: number;
}

/**
 * Composites NFT trait layers in the correct LAYER_ORDER using
 * absolute-positioned images. Falls back to the NFT's main imageUrl
 * if no layer data is available.
 */
export default function NftLayeredImage({
  nft,
  layerOverrides,
  className = "",
  size = 400,
}: NftLayeredImageProps) {
  const [fallback, setFallback] = useState(false);

  const hasLayers =
    nft.layerImageUrls && Object.keys(nft.layerImageUrls).length > 0;

  // If no layer data or fallback triggered, show the main image
  if (!hasLayers || fallback) {
    return (
      <div
        className={`relative overflow-hidden rounded-xl bg-zinc-800 ${className}`}
        style={{ width: size, height: size }}
      >
        {nft.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={nft.imageUrl}
            alt={nft.name}
            className="h-full w-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-zinc-500 text-sm">
            No image
          </div>
        )}
      </div>
    );
  }

  // Merge base layer URLs with any overrides (for preview)
  const effectiveLayers = { ...nft.layerImageUrls };

  if (layerOverrides) {
    for (const [cat, url] of Object.entries(layerOverrides)) {
      const category = cat as OfficialTraitCategory;
      if (url === null) {
        // null means "remove this layer"
        delete effectiveLayers[category];
      } else if (url) {
        effectiveLayers[category] = url;
      }
    }
  }

  // Render layers in LAYER_ORDER
  const layersToRender = LAYER_ORDER.filter(
    (cat) => effectiveLayers[cat] != null
  );

  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-zinc-800 ${className}`}
      style={{ width: size, height: size }}
    >
      {layersToRender.map((category) => (
        <LayerImage
          key={category}
          src={effectiveLayers[category]!}
          alt={`${nft.name} ${category}`}
          size={size}
          onError={() => setFallback(true)}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Internal: single layer image with loading state                   */
/* ------------------------------------------------------------------ */

function LayerImage({
  src,
  alt,
  size,
  onError,
}: {
  src: string;
  alt: string;
  size: number;
  onError: () => void;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className="absolute inset-0 h-full w-full object-cover"
      style={{ width: size, height: size }}
      onError={onError}
      draggable={false}
    />
  );
}
