import { NextRequest, NextResponse } from "next/server";

/* ------------------------------------------------------------------ */
/*  Rate limiting                                                      */
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

/**
 * GET /api/trait-counts
 *
 * Returns mint counts per trait (how many times each trait has been applied).
 *
 * For the open-source template, this returns an empty object.
 * In production, you would connect this to a database (e.g., Supabase,
 * Vercel KV, or a simple JSON file) to track how many times each
 * trait has been swapped.
 *
 * Expected response format:
 *   { [traitId: string]: number }
 *
 * Example production response:
 *   { "bg-sunset": 42, "top-crown": 7, "eyes-laser": 15 }
 */
export async function GET(request: NextRequest) {
  if (isRateLimited(getClientKey(request))) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a minute." },
      { status: 429 }
    );
  }
  // Template default: return empty counts.
  // Replace this with a database query in production.
  //
  // Example with a database:
  // const counts = await db.query("SELECT trait_id, count FROM trait_counts");
  // return NextResponse.json(Object.fromEntries(counts.map(r => [r.trait_id, r.count])));

  return NextResponse.json({});
}
