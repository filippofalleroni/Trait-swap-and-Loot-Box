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
    if (typeof p.amount !== "number" || !Number.isFinite(p.amount) || p.amount < 0) return null;
    if (typeof p.weight !== "number" || !Number.isFinite(p.weight) || p.weight <= 0) return null;
  }
  return data as PrizeTier[];
}

async function loadPrizesFromBlob(): Promise<PrizeTier[] | null> {
  if (!BLOB_TOKEN || !BLOB_PRIZES_URL) return null;

  try {
    const res = await fetch(BLOB_PRIZES_URL, {
      headers: { Authorization: `Bearer ${BLOB_TOKEN}` },
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

/**
 * Get the current prize list.
 * Tries Blob storage first, falls back to config/lootbox.ts.
 */
export async function getPrizes(): Promise<PrizeTier[]> {
  const blobPrizes = await loadPrizesFromBlob();
  return blobPrizes ?? lootboxConfig.prizes;
}
