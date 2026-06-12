import crypto from "crypto";
import { NextResponse } from "next/server";
import algosdk from "algosdk";
import { getAlgodClient } from "@/lib/algorand";

const CONTRACT_APP_ID = Number(process.env.LOOTBOX_CONTRACT_APP_ID ?? "0");
// This route only exists for beacon mode — block-seed opens have no on-chain
// reveal transaction to build.
const USE_BEACON =
  (process.env.LOOTBOX_RANDOMNESS_MODE ?? "block-seed").trim().toLowerCase() === "beacon";

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const ipRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const IP_RATE_LIMIT_MAX = 20;

function pruneRateLimitMap() {
  const now = Date.now();
  rateLimitMap.forEach((entry, key) => {
    if (now >= entry.resetAt) rateLimitMap.delete(key);
  });
  ipRateLimitMap.forEach((entry, key) => {
    if (now >= entry.resetAt) ipRateLimitMap.delete(key);
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

function isIpRateLimited(ip: string): boolean {
  const now = Date.now();
  if (ipRateLimitMap.size > 1000) pruneRateLimitMap();
  const entry = ipRateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    ipRateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > IP_RATE_LIMIT_MAX;
}

function getClientIp(request: Request): string {
  const forwarded = (request.headers as Headers).get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

// The beacon app id lives in the contract's global state under the key
// "beacon" (set at deploy time). Cached after the first read — it only changes
// via a creator-only configure() call, which in practice means a redeploy.
let cachedBeaconAppId: number | null = null;

async function getBeaconAppId(
  algodClient: algosdk.Algodv2,
  contractAppId: number
): Promise<number | null> {
  if (cachedBeaconAppId) return cachedBeaconAppId;
  try {
    const app = (await algodClient
      .getApplicationByID(contractAppId)
      .do()) as unknown as Record<string, unknown>;
    const params = (app["params"] ?? {}) as Record<string, unknown>;
    const globalState = (params["globalState"] ??
      params["global-state"] ??
      []) as Array<{ key: string; value: { uint?: number | bigint } }>;
    const beaconKey = Buffer.from("beacon").toString("base64");
    const entry = globalState.find((kv) => kv.key === beaconKey);
    const id = entry?.value?.uint != null ? Number(entry.value.uint) : 0;
    if (id > 0) {
      cachedBeaconAppId = id;
      return id;
    }
    return null;
  } catch (err) {
    console.error("[lootbox/build-reveal] Failed to read beacon app id:", err);
    return null;
  }
}

export async function POST(request: Request) {
  try {
    if (!USE_BEACON) {
      return NextResponse.json(
        { error: "On-chain reveal is only used in beacon mode." },
        { status: 400 }
      );
    }

    const clientIp = getClientIp(request);
    if (isIpRateLimited(clientIp)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { walletAddress } = body as { walletAddress?: string };

    if (process.env.LOOTBOX_PAUSED === "true") {
      return NextResponse.json(
        { error: "Loot box is temporarily paused." },
        { status: 503 }
      );
    }

    if (!walletAddress || !algosdk.isValidAddress(walletAddress)) {
      return NextResponse.json(
        { error: "A valid wallet address is required." },
        { status: 400 }
      );
    }

    if (isRateLimited(walletAddress.toUpperCase())) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute." },
        { status: 429 }
      );
    }

    if (!CONTRACT_APP_ID) {
      return NextResponse.json(
        { error: "Loot box contract is not configured." },
        { status: 500 }
      );
    }

    const algodClient = getAlgodClient();
    const suggestedParams = await algodClient.getTransactionParams().do();

    // reveal() inner-calls the Randomness Beacon, so the outer transaction must
    // reference the beacon app and pay its inner fee. Read the beacon app id
    // from the contract's own global state (key "beacon") — it's configured at
    // deploy time, so there's no separate env var to drift out of sync.
    const beaconAppId = await getBeaconAppId(algodClient, CONTRACT_APP_ID);
    if (!beaconAppId) {
      return NextResponse.json(
        { error: "Loot box contract is missing its beacon configuration." },
        { status: 500 }
      );
    }

    // Flat 3x min fee: the outer call + the inner beacon call, with headroom
    // for any beacon-internal inner transactions.
    const minFee = BigInt(suggestedParams.minFee ?? 1000);
    suggestedParams.flatFee = true;
    suggestedParams.fee = minFee * BigInt(3);

    const revealSelector = new Uint8Array(
      Buffer.from(
        crypto.createHash("sha512-256").update("reveal()uint64").digest()
      ).subarray(0, 4)
    );

    const senderPk = algosdk.decodeAddress(walletAddress).publicKey;
    // Commit boxes are keyed 'c' + pubkey (the contract's BoxMap prefix).
    const commitBoxName = new Uint8Array(
      Buffer.concat([Buffer.from("c"), Buffer.from(senderPk)])
    );

    const appCallTxn = algosdk.makeApplicationCallTxnFromObject({
      sender: walletAddress,
      appIndex: CONTRACT_APP_ID,
      onComplete: algosdk.OnApplicationComplete.NoOpOC,
      appArgs: [revealSelector],
      foreignApps: [beaconAppId],
      boxes: [{ appIndex: CONTRACT_APP_ID, name: commitBoxName }],
      suggestedParams,
    });

    const b64 = Buffer.from(appCallTxn.toByte()).toString("base64");

    return NextResponse.json({
      txId: appCallTxn.txID(),
      unsignedTxn: b64,
    });
  } catch (err: unknown) {
    console.error("[lootbox/build-reveal]", err);
    return NextResponse.json(
      { error: "Failed to build reveal transaction." },
      { status: 500 }
    );
  }
}
