"use server";

import algosdk from "algosdk";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { isAdminWallet } from "@/config/admin";
import { lootboxConfig } from "@/config/lootbox";
import { getAlgodClient } from "@/lib/algorand";
import { getTreasuryAddress } from "@/lib/treasury";
import { getLootboxMasterAccount } from "@/lib/lootbox-master-wallet";
import type { PrizeTier } from "@/lib/types";

// ---------------------------------------------------------------------------
// In-memory challenge store with TTL.
// Each admin wallet gets a random hex nonce that must be included in the note
// field of a signed (but never submitted) zero-amount self-payment.
// Challenges expire after 5 minutes to prevent memory accumulation.
// ---------------------------------------------------------------------------
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const challenges = new Map<string, { nonce: string; expires: number }>();

// In-memory session set (wallet addresses that have authenticated).
const sessions = new Set<string>();

function pruneExpiredChallenges() {
  const now = Date.now();
  challenges.forEach((val, key) => {
    if (val.expires < now) challenges.delete(key);
  });
}

// Fallback path when Vercel Blob is not available (local dev only).
// WARNING: /tmp is not persistent across deploys and is shared on some hosts.
// For production without Vercel Blob, use a database or secure storage.
const LOCAL_PRIZES_PATH = path.join("/tmp", "lootbox-prizes.json");

// ---------------------------------------------------------------------------
// Helper: assert the caller is an admin
// ---------------------------------------------------------------------------
function assertAdmin(walletAddress: string | null) {
  if (!walletAddress || !isAdminWallet(walletAddress)) {
    throw new Error("Unauthorized: wallet is not an admin.");
  }
}

// ---------------------------------------------------------------------------
// Helper: assert the caller has an active session
// ---------------------------------------------------------------------------
function assertSession(walletAddress: string) {
  if (!sessions.has(walletAddress)) {
    throw new Error("No active session. Please authenticate first.");
  }
}

// ---------------------------------------------------------------------------
// 1. adminGetChallenge
//    Generate a random hex nonce for the given admin wallet.
//    The admin will sign a self-payment transaction containing this nonce
//    in the note field to prove wallet ownership.
// ---------------------------------------------------------------------------
export async function adminGetChallenge(
  walletAddress: string
): Promise<{ challenge: string }> {
  assertAdmin(walletAddress);

  pruneExpiredChallenges();

  const challenge = crypto.randomBytes(16).toString("hex");
  challenges.set(walletAddress, {
    nonce: challenge,
    expires: Date.now() + CHALLENGE_TTL_MS,
  });

  return { challenge };
}

// ---------------------------------------------------------------------------
// 2. adminCreateSession
//    Verify the signed transaction:
//      - It is a self-payment (sender === receiver === walletAddress)
//      - The note field contains the expected nonce
//    On success the wallet is added to the session set.
// ---------------------------------------------------------------------------
export async function adminCreateSession(
  walletAddress: string,
  signedBase64: string
): Promise<{ ok: boolean }> {
  assertAdmin(walletAddress);

  const entry = challenges.get(walletAddress);
  if (!entry || entry.expires < Date.now()) {
    challenges.delete(walletAddress);
    throw new Error("No challenge found or challenge expired. Call adminGetChallenge first.");
  }

  // Decode the signed transaction to inspect its fields.
  const signedBytes = Buffer.from(signedBase64, "base64");
  const decoded = algosdk.decodeSignedTransaction(signedBytes);
  const txn = decoded.txn;

  // Verify the note contains our nonce.
  const noteStr = txn.note
    ? Buffer.from(txn.note).toString("utf-8")
    : "";
  if (noteStr !== entry.nonce) {
    throw new Error("Challenge nonce not found in transaction note.");
  }

  // Verify sender matches the claimed admin wallet.
  const senderAddr = txn.sender.toString();
  if (senderAddr !== walletAddress) {
    throw new Error("Transaction sender does not match wallet address.");
  }

  // Clean up and create session.
  challenges.delete(walletAddress);
  sessions.add(walletAddress);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3. adminGetPrizes
//    Load the current prize configuration.
//    First tries Vercel Blob (if BLOB_READ_WRITE_TOKEN is set), then falls
//    back to a local JSON file, and finally to the default config.
// ---------------------------------------------------------------------------
export async function adminGetPrizes(
  walletAddress: string
): Promise<{ prizes: PrizeTier[] }> {
  assertAdmin(walletAddress);
  assertSession(walletAddress);

  // Try Vercel Blob storage.
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { list } = await import("@vercel/blob");
      const blobs = await list({ prefix: "lootbox-prizes.json" });
      if (blobs.blobs.length > 0) {
        const res = await fetch(blobs.blobs[0].url);
        const prizes = (await res.json()) as PrizeTier[];
        return { prizes };
      }
    } catch {
      // Fall through to local file or default config.
    }
  }

  // Try local JSON file.
  try {
    if (fs.existsSync(LOCAL_PRIZES_PATH)) {
      const raw = fs.readFileSync(LOCAL_PRIZES_PATH, "utf-8");
      const prizes = JSON.parse(raw) as PrizeTier[];
      return { prizes };
    }
  } catch {
    // Fall through to default config.
  }

  // Default: return prizes from the config file.
  return { prizes: lootboxConfig.prizes };
}

// ---------------------------------------------------------------------------
// 4. adminSavePrizes
//    Persist the prize configuration.
//    Uses Vercel Blob if BLOB_READ_WRITE_TOKEN is set, otherwise saves to a
//    local JSON file in /tmp.
// ---------------------------------------------------------------------------
export async function adminSavePrizes(
  walletAddress: string,
  prizes: PrizeTier[]
): Promise<{ count: number }> {
  assertAdmin(walletAddress);
  assertSession(walletAddress);

  const payload = JSON.stringify(prizes, null, 2);

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { put } = await import("@vercel/blob");
      await put("lootbox-prizes.json", payload, {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
      });
      return { count: prizes.length };
    } catch {
      // Fall through to local storage.
    }
  }

  // Fallback: write to local file system.
  fs.writeFileSync(LOCAL_PRIZES_PATH, payload, "utf-8");
  return { count: prizes.length };
}

// ---------------------------------------------------------------------------
// 5. adminGetRevenue
//    Query algod for treasury and master wallet balances, and return
//    aggregate revenue statistics.
// ---------------------------------------------------------------------------
export async function adminGetRevenue(walletAddress: string): Promise<{
  treasuryBalanceMicroAlgo: number;
  masterWalletBalanceMicroAlgo: number;
  cratePrice: number;
}> {
  assertAdmin(walletAddress);
  assertSession(walletAddress);

  const algod = getAlgodClient();
  const treasuryAddr = getTreasuryAddress();

  let treasuryBalanceMicroAlgo = 0;
  let masterWalletBalanceMicroAlgo = 0;

  // Fetch treasury balance.
  try {
    const treasuryInfo = await algod.accountInformation(treasuryAddr).do();
    treasuryBalanceMicroAlgo = Number(treasuryInfo.amount ?? 0);
  } catch {
    // Treasury address may not exist on-chain yet.
  }

  // Fetch master wallet balance.
  try {
    const masterAccount = getLootboxMasterAccount();
    const masterInfo = await algod
      .accountInformation(masterAccount.addr)
      .do();
    masterWalletBalanceMicroAlgo = Number(masterInfo.amount ?? 0);
  } catch {
    // Master wallet mnemonic may not be set.
  }

  return {
    treasuryBalanceMicroAlgo,
    masterWalletBalanceMicroAlgo,
    cratePrice: lootboxConfig.cratePrice,
  };
}

// ---------------------------------------------------------------------------
// 6. adminGetBuyerNfts
//    Return a list of recent NFT asset IDs held by the master wallet.
//    This gives admins visibility into the prize pool inventory.
// ---------------------------------------------------------------------------
export async function adminGetBuyerNfts(
  walletAddress: string
): Promise<{ nfts: { assetId: number; amount: number; name?: string }[] }> {
  assertAdmin(walletAddress);
  assertSession(walletAddress);

  try {
    const algod = getAlgodClient();
    const masterAccount = getLootboxMasterAccount();
    const accountInfo = await algod
      .accountInformation(masterAccount.addr)
      .do();

    const assets = (accountInfo.assets ?? []) as unknown as Array<{
      "asset-id": number;
      amount: number;
    }>;

    const nfts = assets
      .filter((a) => Number(a.amount) > 0)
      .map((a) => ({
        assetId: Number(a["asset-id"]),
        amount: Number(a.amount),
      }));

    return { nfts };
  } catch {
    return { nfts: [] };
  }
}

// ---------------------------------------------------------------------------
// 7. adminOptIn
//    Opt the master wallet into a new ASA by sending a zero-amount asset
//    transfer from the master wallet to itself. This is required before the
//    master wallet can hold (and distribute) that asset as a prize.
// ---------------------------------------------------------------------------
export async function adminOptIn(
  walletAddress: string,
  assetId: number
): Promise<{ message: string }> {
  assertAdmin(walletAddress);
  assertSession(walletAddress);

  const algod = getAlgodClient();
  const masterAccount = getLootboxMasterAccount();
  const params = await algod.getTransactionParams().do();

  // Build a zero-amount asset transfer to self (opt-in).
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: masterAccount.addr,
    receiver: masterAccount.addr,
    assetIndex: assetId,
    amount: 0,
    suggestedParams: params,
  });

  const signedTxn = txn.signTxn(masterAccount.sk);
  await algod.sendRawTransaction(signedTxn).do();
  await algosdk.waitForConfirmation(algod, txn.txID(), 4);

  return {
    message: `Master wallet opted in to asset ${assetId} successfully.`,
  };
}
