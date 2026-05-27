"use client";

import React, { useEffect, useMemo, useState } from "react";
import { LAYER_ORDER, getTraitLayerImageCandidates } from "@/lib/nft-layering";
import type { CollectionNft, OfficialTraitCategory } from "@/lib/types";

type LayerEntry = {
  category: OfficialTraitCategory;
  traitValue: string;
  previewImageUrl: string | undefined;
  candidates: Array<{ src: string; key: string }>;
};

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
 *
 * Each layer independently tries fallback image candidates on error,
 * rather than collapsing the entire view on a single broken layer.
 */
export default function NftLayeredImage({
  nft,
  layerOverrides,
  className = "",
  size = 400,
}: NftLayeredImageProps) {
  const [layerAttemptIndex, setLayerAttemptIndex] = useState<Record<string, number>>({});

  // Reset attempt indices when the NFT changes
  useEffect(() => {
    setLayerAttemptIndex({});
  }, [nft]);

  const hasLayers =
    nft.layerImageUrls && Object.keys(nft.layerImageUrls).length > 0;

  // Merge base layer URLs with any overrides (for preview)
  const effectiveLayers = useMemo(() => {
    const merged: Partial<Record<OfficialTraitCategory, string>> = {
      ...nft.layerImageUrls,
    };

    if (layerOverrides) {
      Object.entries(layerOverrides).forEach(function applyOverride([cat, url]) {
        const category = cat as OfficialTraitCategory;
        if (url === null) {
          // null means "remove this layer"
          delete merged[category];
        } else if (url) {
          merged[category] = url;
        }
      });
    }

    return merged;
  }, [nft.layerImageUrls, layerOverrides]);

  // Build layer entries with fallback candidates
  const layerEntries = useMemo(
    () =>
      LAYER_ORDER.map(function buildEntry(category) {
        const traitValue = nft.layers?.[category];
        const overrideUrl = effectiveLayers[category];
        if (!overrideUrl && (!traitValue || traitValue === "None")) return null;

        const previewImageUrl = overrideUrl ?? nft.layerImageUrls?.[category];
        return {
          category,
          traitValue: traitValue ?? category,
          previewImageUrl,
          candidates: previewImageUrl
            ? [{ src: previewImageUrl, key: category + "-" + (traitValue ?? category) + "-preview" }]
            : getTraitLayerImageCandidates(category, traitValue ?? category),
        };
      }).filter(function isEntry(value): value is LayerEntry {
        return Boolean(value);
      }),
    [nft, effectiveLayers]
  );

  // Compute current URLs for preloading
  const layerUrls = useMemo(
    () =>
      layerEntries.map(function resolveUrl(entry) {
        const layerKey = entry.category + ":" + entry.traitValue + ":" + (entry.previewImageUrl ?? "default");
        const currentIndex = layerAttemptIndex[layerKey] ?? 0;
        return entry.candidates[currentIndex]?.src ?? entry.candidates[0]?.src;
      }),
    [layerAttemptIndex, layerEntries]
  );

  // Preload images for smoother layer transitions
  useEffect(() => {
    const images = layerUrls.map(function preload(url) {
      const image = new window.Image();
      image.decoding = "async";
      image.loading = "eager";
      image.src = url;
      return image;
    });

    return function cleanup() {
      images.forEach(function cancel(img) { img.src = ""; });
      images.length = 0;
    };
  }, [layerUrls]);

  // If no layer data at all, show the main image
  if (!hasLayers && !layerOverrides) {
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
            onError={function hideOnErr(e) {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-zinc-500 text-sm">
            No image
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-zinc-800 ${className}`}
      style={{ width: size, height: size }}
    >
      {layerEntries.map(function renderLayer(entry) {
        const layerKey = entry.category + ":" + entry.traitValue + ":" + (entry.previewImageUrl ?? "default");
        const currentIndex = layerAttemptIndex[layerKey] ?? 0;
        const imageUrl = entry.candidates[currentIndex]?.src;
        if (!imageUrl) return null;

        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={entry.category + "-" + entry.traitValue + "-" + imageUrl}
            src={imageUrl}
            alt={nft.name + " " + entry.category}
            loading="eager"
            onError={function tryNext() {
              setLayerAttemptIndex(function advance(current) {
                const nextIndex = (current[layerKey] ?? 0) + 1;
                if (nextIndex >= entry.candidates.length) return current;
                const updated: Record<string, number> = {};
                Object.keys(current).forEach(function copy(k) {
                  updated[k] = current[k];
                });
                updated[layerKey] = nextIndex;
                return updated;
              });
            }}
            className="absolute inset-0 h-full w-full object-cover"
            style={{ width: size, height: size }}
            draggable={false}
          />
        );
      })}
    </div>
  );
}
