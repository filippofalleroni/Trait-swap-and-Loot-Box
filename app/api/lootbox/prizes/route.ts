import { NextResponse } from "next/server";
import { lootboxConfig, totalPrizeWeight } from "@/config/lootbox";
import type { PrizeTier } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  GET /api/lootbox/prizes                                           */
/*                                                                    */
/*  Returns the current prize list with calculated drop chances.      */
/*  Loads from Vercel Blob if BLOB_READ_WRITE_TOKEN is set,           */
/*  otherwise falls back to config/lootbox.ts.                        */
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

export async function GET() {
  try {
    // Try Blob storage first, fall back to config
    const blobPrizes = await loadPrizesFromBlob();
    const prizes: PrizeTier[] = blobPrizes ?? lootboxConfig.prizes;

    const total = prizes.reduce((sum, p) => sum + p.weight, 0) || totalPrizeWeight;

    const prizesWithChance = prizes.map((p) => ({
      ...p,
      chance: Number(((p.weight / total) * 100).toFixed(2)),
    }));

    return NextResponse.json({
      prizes: prizesWithChance,
      totalWeight: total,
      count: prizes.length,
    });
  } catch (err: unknown) {
    console.error("[lootbox/prizes]", err);
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
