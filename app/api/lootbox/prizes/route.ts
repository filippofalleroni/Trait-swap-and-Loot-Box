import { NextRequest, NextResponse } from "next/server";
import { totalPrizeWeight } from "@/config/lootbox";
import { getPrizes } from "@/lib/lootbox-prize-store";

/* ------------------------------------------------------------------ */
/*  GET /api/lootbox/prizes                                           */
/*                                                                    */
/*  Returns the current prize list with calculated drop chances.      */
/*  Loads from Vercel Blob if BLOB_READ_WRITE_TOKEN is set,           */
/*  otherwise falls back to config/lootbox.ts.                        */
/* ------------------------------------------------------------------ */

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/*  Rate limiting (global by forwarded IP or fallback key)             */
/* ------------------------------------------------------------------ */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

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

function getClientKey(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function GET(request: NextRequest) {
  if (isRateLimited(getClientKey(request))) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a minute." },
      { status: 429 }
    );
  }
  try {
    const prizes = await getPrizes();

    const total =
      prizes.reduce((sum, p) => sum + p.weight, 0) || totalPrizeWeight;

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
    return NextResponse.json(
      { error: "Failed to load prize data." },
      { status: 500 }
    );
  }
}
