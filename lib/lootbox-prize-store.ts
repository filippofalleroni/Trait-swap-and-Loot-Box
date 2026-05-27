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

async function loadPrizesFromBlob(): Promise<PrizeTier[] | null> {
  if (!BLOB_TOKEN || !BLOB_PRIZES_URL) return null;

  try {
    const res = await fetch(BLOB_PRIZES_URL, {
      headers: { Authorization: `Bearer ${BLOB_TOKEN}` },
      next: { revalidate: 60 },
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (Array.isArray(data)) return data as PrizeTier[];
    if (data?.prizes && Array.isArray(data.prizes))
      return data.prizes as PrizeTier[];

    return null;
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
