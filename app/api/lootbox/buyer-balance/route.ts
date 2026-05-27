import { NextRequest, NextResponse } from "next/server";
import algosdk from "algosdk";
import { getAlgodClient } from "@/lib/algorand";

/* ------------------------------------------------------------------ */
/*  GET /api/lootbox/buyer-balance                                    */
/*                                                                    */
/*  Returns the ALGO balance of the loot box master wallet.           */
/*  If the master wallet is not configured, returns 0.                */
/* ------------------------------------------------------------------ */

export const dynamic = "force-dynamic";

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

/* Derive the master address once at module load, not on every request.
   This avoids repeatedly parsing the secret mnemonic on a public endpoint. */
let masterAddress: string | null = null;
try {
  const mnemonic = process.env.LOOTBOX_MASTER_MNEMONIC?.trim();
  if (mnemonic) {
    const account = algosdk.mnemonicToSecretKey(mnemonic);
    masterAddress = account.addr.toString();
  }
} catch {
  // Mnemonic invalid or missing — masterAddress stays null.
}

export async function GET(request: NextRequest) {
  if (isRateLimited(getClientKey(request))) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a minute." },
      { status: 429 }
    );
  }

  try {
    if (!masterAddress) {
      return NextResponse.json({ balanceAlgo: 0 });
    }

    const algodClient = getAlgodClient();
    const accountInfo = (await algodClient
      .accountInformation(masterAddress)
      .do()) as unknown as Record<string, unknown>;

    const balanceMicro = Number(accountInfo?.amount ?? 0);
    const balanceAlgo = Math.floor((balanceMicro / 1_000_000) * 100) / 100;

    return NextResponse.json({
      balanceAlgo,
    });
  } catch (err: unknown) {
    console.error("[lootbox/buyer-balance]", err);
    return NextResponse.json({ balanceAlgo: 0 });
  }
}
