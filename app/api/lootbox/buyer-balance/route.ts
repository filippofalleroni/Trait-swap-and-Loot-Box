import { NextResponse } from "next/server";
import { getAlgodClient } from "@/lib/algorand";

/* ------------------------------------------------------------------ */
/*  GET /api/lootbox/buyer-balance                                    */
/*                                                                    */
/*  Returns the ALGO balance of the loot box master wallet.           */
/*  If the master wallet is not configured, returns 0.                */
/* ------------------------------------------------------------------ */

export async function GET() {
  try {
    const mnemonic = process.env.LOOTBOX_MASTER_MNEMONIC?.trim();

    if (!mnemonic) {
      return NextResponse.json({ balanceAlgo: 0 });
    }

    // Derive address from mnemonic without importing the full account
    // (we only need the address, not the secret key, for a balance check)
    const algosdk = (await import("algosdk")).default;
    const account = algosdk.mnemonicToSecretKey(mnemonic);
    const masterAddress = account.addr;

    const algodClient = getAlgodClient();
    const accountInfo = (await algodClient
      .accountInformation(masterAddress)
      .do()) as unknown as Record<string, unknown>;

    const balanceMicro = Number(accountInfo?.amount ?? 0);

    const balanceAlgo = balanceMicro / 1_000_000;

    return NextResponse.json({
      balanceAlgo: Number(balanceAlgo.toFixed(6)),
      address: masterAddress,
    });
  } catch (err: unknown) {
    console.error("[lootbox/buyer-balance]", err);
    return NextResponse.json({ balanceAlgo: 0 });
  }
}
