import { NextRequest, NextResponse } from "next/server";
import algosdk from "algosdk";
import { INDEXER_BASE_URL, resolveArc19Url } from "@/lib/algorand";
import { COLLECTION_CREATOR_ADDRESS, COLLECTION_UNIT_PREFIX } from "@/config/collection";
import type { CollectionNft, OfficialTraitCategory } from "@/lib/types";
import { isOfficialTraitCategory, getTraitLayerImageUrl } from "@/lib/nft-layering";
import { isBlockedHostname } from "@/lib/security";

/* ------------------------------------------------------------------ */
/*  Rate limiting                                                      */
/* ------------------------------------------------------------------ */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

function pruneRateLimitMap() {
  const now = Date.now();
  rateLimitMap.forEach((entry, key) => {
    if (now >= entry.resetAt) rateLimitMap.delete(key);
  });
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  if (rateLimitMap.size > 1000) pruneRateLimitMap();
  const entry = rateLimitMap.get(key);
  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

/**
 * GET /api/owned-nfts?wallet=ADDRESS
 *
 * Returns collection NFTs held by the specified wallet address.
 *
 * How it works:
 * 1. Queries the Algorand Indexer for all assets held by the wallet.
 * 2. Filters to only assets created by the collection creator address.
 * 3. For each matching NFT, fetches ARC-19/ARC-69 metadata to extract
 *    trait layers for the layered image renderer.
 *
 * CUSTOMIZATION:
 * - Set COLLECTION_CREATOR_ADDRESS in config/collection.ts to your
 *   collection's creator wallet.
 * - If your metadata format differs from standard ARC-19/ARC-69,
 *   update the parseMetadata() helper below.
 */
export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet");

  if (!wallet) {
    return NextResponse.json(
      { error: "Missing 'wallet' query parameter" },
      { status: 400 }
    );
  }

  if (!algosdk.isValidAddress(wallet)) {
    return NextResponse.json(
      { error: "Invalid wallet address format." },
      { status: 400 }
    );
  }

  if (isRateLimited(wallet)) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a minute." },
      { status: 429 }
    );
  }

  // Validate that the collection creator address has been configured
  if (
    !COLLECTION_CREATOR_ADDRESS ||
    COLLECTION_CREATOR_ADDRESS === "YOUR_COLLECTION_CREATOR_ADDRESS"
  ) {
    // Return empty array when collection is not configured yet (demo mode).
    // The UI will fall back to mock data.
    return NextResponse.json({ nfts: [] });
  }

  try {
    // Step 1: Query Indexer for all assets held by this wallet
    const accountUrl = `${INDEXER_BASE_URL}/v2/accounts/${wallet}/assets?include-all=false`;
    const accountRes = await fetch(accountUrl);

    if (!accountRes.ok) {
      throw new Error(`Indexer account lookup failed: ${accountRes.status}`);
    }

    const accountData = await accountRes.json();
    const heldAssets: { "asset-id": number; amount: number }[] =
      accountData.assets ?? [];

    // Keep only assets the wallet actually holds (amount > 0)
    const nonZeroAssets = heldAssets.filter((a) => a.amount > 0);

    if (nonZeroAssets.length === 0) {
      return NextResponse.json({ nfts: [] });
    }

    // Cap the number of assets to process to prevent resource exhaustion
    const MAX_ASSETS_TO_PROCESS = 200;
    if (nonZeroAssets.length > MAX_ASSETS_TO_PROCESS) {
      nonZeroAssets.length = MAX_ASSETS_TO_PROCESS;
    }

    // Step 2: For each asset, check creator and fetch metadata
    const nfts: CollectionNft[] = [];

    // Process in batches to avoid hitting rate limits
    const BATCH_SIZE = 10;
    for (let i = 0; i < nonZeroAssets.length; i += BATCH_SIZE) {
      const batch = nonZeroAssets.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (asset) => {
          const assetUrl = `${INDEXER_BASE_URL}/v2/assets/${asset["asset-id"]}`;
          const assetRes = await fetch(assetUrl);

          if (!assetRes.ok) return null;

          const assetData = await assetRes.json();
          const assetInfo = assetData.asset;

          if (!assetInfo) return null;

          // Filter: only include NFTs from our collection's creator
          const creator = assetInfo.params?.creator;
          if (creator !== COLLECTION_CREATOR_ADDRESS) return null;

          // Optional: filter by unit name prefix
          const unitName: string = assetInfo.params?.["unit-name"] ?? "";
          if (
            COLLECTION_UNIT_PREFIX &&
            !unitName.startsWith(COLLECTION_UNIT_PREFIX)
          ) {
            return null;
          }

          // Step 3: Extract metadata (ARC-19 or ARC-69)
          const nftName: string = assetInfo.params?.name ?? `NFT #${asset["asset-id"]}`;
          const url: string = assetInfo.params?.url ?? "";
          const reserve: string | undefined = assetInfo.params?.reserve;

          // Try to resolve the metadata URL.
          // resolveArc19Url handles ARC-19 template URLs (using the reserve
          // address to derive the IPFS CID) as well as plain ipfs:// URLs.
          // For http(s) URLs we fall back to resolveIpfsUrl which applies
          // SSRF protection (blocking internal/private hostnames).
          const metadataUrl =
            (url.startsWith("template-ipfs://") || url.startsWith("ipfs://"))
              ? resolveArc19Url(url, reserve)
              : resolveIpfsUrl(url);
          let metadata: Record<string, unknown> | null = null;

          if (metadataUrl) {
            try {
              const metaRes = await fetch(metadataUrl, {
                signal: AbortSignal.timeout(5000),
                redirect: "error",
              });
              if (metaRes.ok) {
                metadata = await metaRes.json();
              }
            } catch {
              // Metadata fetch failed; continue without layer data
            }
          }

          // Parse trait layers from metadata properties
          const { layers, layerImageUrls, traits } = parseMetadata(metadata);

          // Resolve the main image URL
          let imageUrl = "";
          if (metadata && typeof metadata.image === "string") {
            const img = metadata.image;
            imageUrl =
              (img.startsWith("ipfs://") ? resolveArc19Url(img, undefined) : null)
              ?? resolveIpfsUrl(img)
              ?? "";
          } else if (url) {
            imageUrl =
              (url.startsWith("template-ipfs://") || url.startsWith("ipfs://"))
                ? (resolveArc19Url(url, reserve) ?? "")
                : (resolveIpfsUrl(url) ?? "");
          }

          const nft: CollectionNft = {
            id: `asa-${asset["asset-id"]}`,
            name: nftName,
            imageUrl,
            traits,
            assetId: asset["asset-id"],
            unitName,
            metadataUrl: metadataUrl ?? undefined,
            layers: Object.keys(layers).length > 0 ? layers : undefined,
            layerImageUrls:
              Object.keys(layerImageUrls).length > 0
                ? layerImageUrls
                : undefined,
          };

          return nft;
        })
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          nfts.push(result.value);
        }
      }
    }

    return NextResponse.json({ nfts });
  } catch (err) {
    console.error("[owned-nfts] Error:", err);
    return NextResponse.json(
      { error: "Failed to fetch owned NFTs" },
      { status: 500 }
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve an IPFS URI (ipfs://CID or template:// formats) to an
 * HTTP gateway URL. Pass through if already HTTP(S).
 */
function resolveIpfsUrl(url: string): string | null {
  if (!url) return null;

  // ARC-19 template format: template-ipfs://{ipfscid:VERSION:CODEC:FIELD:HASH}
  if (url.startsWith("template-ipfs://")) {
    // For ARC-19, the actual CID is stored in the reserve address.
    // We can't resolve this client-side without the reserve address,
    // so we return null and rely on the imageUrl from metadata.
    return null;
  }

  if (url.startsWith("ipfs://")) {
    const cid = url.replace("ipfs://", "");
    return `https://ipfs.io/ipfs/${cid}`;
  }

  if (url.startsWith("https://")) {
    // Block requests to private/internal hostnames to prevent SSRF
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      if (isBlockedHostname(hostname)) {
        return null;
      }
    } catch {
      return null;
    }
    return url;
  }

  // Block plain http:// to prevent SSRF to internal services
  return null;
}

/**
 * Parse ARC-19/ARC-69 metadata to extract trait layers.
 *
 * Expected metadata format:
 * {
 *   "properties": {
 *     "BACKGROUND": "Sunset",
 *     "SKIN": "Blue",
 *     "BODY": "Hoodie",
 *     ...
 *   }
 * }
 *
 * CUSTOMIZATION: If your collection uses a different metadata format
 * (e.g., nested "attributes" array like ERC-721), modify this function.
 */
function parseMetadata(metadata: Record<string, unknown> | null): {
  layers: Partial<Record<OfficialTraitCategory, string>>;
  layerImageUrls: Partial<Record<OfficialTraitCategory, string>>;
  traits: string[];
} {
  const layers: Partial<Record<OfficialTraitCategory, string>> = {};
  const layerImageUrls: Partial<Record<OfficialTraitCategory, string>> = {};
  const traits: string[] = [];

  if (!metadata) return { layers, layerImageUrls, traits };

  // Standard ARC format: metadata.properties is a flat object
  const properties = metadata.properties as Record<string, string> | undefined;

  if (properties && typeof properties === "object") {
    for (const [key, value] of Object.entries(properties)) {
      if (typeof value !== "string" || !value) continue;

      const upperKey = key.toUpperCase();
      if (isOfficialTraitCategory(upperKey)) {
        layers[upperKey] = value;
        layerImageUrls[upperKey] = getTraitLayerImageUrl(upperKey, value);
        traits.push(value);
      }
    }
  }

  return { layers, layerImageUrls, traits };
}
