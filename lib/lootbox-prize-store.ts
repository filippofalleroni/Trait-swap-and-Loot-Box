import { lootboxConfig } from "@/config/lootbox";
import type { PrizeTier } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Prize Store                                                       */
/*                                                                    */
/*  Loads prizes from Vercel Blob when configured, otherwise falls    */
/*  back to the static config in config/lootbox.ts.                   */
/*  Used by both the /api/lootbox/prizes and /api/lootbox/reveal      */
/*  routes so that admin-saved prizes are used everywhere.            */
/* ------------------------------------------------------------------ */

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN ?? "";
const BLOB_PRIZES_URL = process.env.LOOTBOX_PRIZES_BLOB_URL ?? "";

const VALID_RARITIES = new Set(["common", "uncommon", "rare", "epic", "legendary"]);
const VALID_TYPES = new Set(["token", "nft"]);

/**
 * Validate that a blob-loaded prize array contains well-formed entries.
 * Returns the validated array or null if any entry is malformed.
 */
function validatePrizes(data: unknown[]): PrizeTier[] | null {
  for (let i = 0; i < data.length; i++) {
    const p = data[i] as Record<string, unknown>;
    if (!p || typeof p !== "object") return null;
    if (typeof p.id !== "string" || !p.id) return null;
    if (typeof p.name !== "string" || !p.name) return null;
    if (typeof p.type !== "string" || !VALID_TYPES.has(p.type)) return null;
    if (typeof p.rarity !== "string" || !VALID_RARITIES.has(p.rarity)) return null;
    if (typeof p.color !== "string") return null;
    if (typeof p.assetId !== "number" || !Number.isFinite(p.assetId) || p.assetId < 0) return null;
    if (p.assetId === 0 && p.type !== "token") return null;
    if (typeof p.amount !== "number" || !Number.isFinite(p.amount) || p.amount <= 0) return null;
    if (typeof p.weight !== "number" || !Number.isFinite(p.weight) || p.weight <= 0) return null;
  }
  return data as PrizeTier[];
}

async function fetchAndValidate(url: string, headers?: Record<string, string>): Promise<PrizeTier[] | null> {
  try {
    const res = await fetch(url, {
      headers,
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const arr = Array.isArray(data)
      ? data
      : data?.prizes && Array.isArray(data.prizes)
        ? data.prizes
        : null;

    if (!arr) return null;
    return validatePrizes(arr);
  } catch {
    return null;
  }
}

async function loadPrizesFromBlob(): Promise<PrizeTier[] | null> {
  if (!BLOB_TOKEN) return null;

  // Primary path: use @vercel/blob list() to find the blob by name.
  // This reads the same blob that adminSavePrizes writes to via put().
  try {
    const { list } = await import("@vercel/blob");
    const blobs = await list({ prefix: "lootbox-prizes.json" });
    if (blobs.blobs.length > 0) {
      const result = await fetchAndValidate(blobs.blobs[0].url);
      if (result) return result;
    }
  } catch {
    // Fall through to direct URL fallback.
  }

  // Fallback: use explicit LOOTBOX_PRIZES_BLOB_URL if set.
  if (BLOB_PRIZES_URL) {
    return fetchAndValidate(BLOB_PRIZES_URL, {
      Authorization: `Bearer ${BLOB_TOKEN}`,
    });
  }

  return null;
}

/**
 * Get the current prize list.
 * Tries Blob storage first, falls back to config/lootbox.ts.
 */
export async function getPrizes(): Promise<PrizeTier[]> {
  const blobPrizes = await loadPrizesFromBlob();
  return blobPrizes ?? lootboxConfig.prizes;
}
