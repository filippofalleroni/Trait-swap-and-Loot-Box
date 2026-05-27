import { NextRequest, NextResponse } from "next/server";
import algosdk from "algosdk";

type NfdLookupRecord = {
  name?: string;
};

const NFD_API_BASE = "https://api.nf.domains";

/* ------------------------------------------------------------------ */
/*  Rate limiting                                                      */
/* ------------------------------------------------------------------ */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 15;

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

function isValidAlgorandAddress(address: string): boolean {
  try {
    algosdk.decodeAddress(address);
    return true;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address")?.trim();

  if (!address || !isValidAlgorandAddress(address)) {
    return NextResponse.json(
      { error: "A valid Algorand address is required." },
      { status: 400 }
    );
  }

  if (isRateLimited(address)) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a minute." },
      { status: 429 }
    );
  }

  const lookupUrl = new URL("/nfd/lookup", NFD_API_BASE);
  lookupUrl.searchParams.set("address", address);

  try {
    const response = await fetch(lookupUrl, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    });

    if (response.status === 404) {
      return NextResponse.json({ nfd: null });
    }

    if (!response.ok) {
      return NextResponse.json(
        { error: `NFD lookup failed with status ${response.status}.` },
        { status: response.status }
      );
    }

    const data = (await response.json()) as Record<
      string,
      NfdLookupRecord | undefined
    >;
    return NextResponse.json({ nfd: data[address]?.name ?? null });
  } catch (error) {
    console.error("Failed to reverse-resolve NFD", error);
    return NextResponse.json(
      { error: "Failed to look up NFD." },
      { status: 500 }
    );
  }
}
