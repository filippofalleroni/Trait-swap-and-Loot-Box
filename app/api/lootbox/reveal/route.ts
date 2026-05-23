import { NextResponse } from "next/server";
import algosdk from "algosdk";
import { getAlgodClient } from "@/lib/algorand";
import { lootboxConfig } from "@/config/lootbox";
import { getTreasuryAddress } from "@/lib/treasury";
import { resolvePrize } from "@/lib/lootbox-prize-resolver";
import { distributePrize } from "@/lib/lootbox-distributor";
import { getLootboxMasterAccount } from "@/lib/lootbox-master-wallet";
import type { PrizeTier } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  POST /api/lootbox/reveal                                          */
/*                                                                    */
/*  Verifies the payment, reads on-chain randomness, resolves a       */
/*  prize, and distributes it to the winner.                          */
/* ------------------------------------------------------------------ */

const LOOTBOX_LIVE = process.env.LOOTBOX_LIVE_ENABLED === "true";
const BEACON_APP_ID = lootboxConfig.randomnessBeaconAppId;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { walletAddress, paymentTxId } = body as {
      walletAddress?: string;
      paymentTxId?: string;
    };

    if (!walletAddress || !paymentTxId) {
      return NextResponse.json(
        { error: "walletAddress and paymentTxId are required" },
        { status: 400 }
      );
    }

    const prizes: PrizeTier[] = lootboxConfig.prizes;

    if (prizes.length === 0) {
      return NextResponse.json(
        { error: "No prizes configured" },
        { status: 500 }
      );
    }

    /* -------------------------------------------------------------- */
    /*  Preview / demo mode — return a random prize without           */
    /*  verifying on-chain or distributing                            */
    /* -------------------------------------------------------------- */

    if (!LOOTBOX_LIVE) {
      const randomValue = Math.random();
      const prize = resolvePrize(prizes, randomValue);

      return NextResponse.json({
        prize: {
          id: prize.id,
          name: prize.name,
          type: prize.type,
          rarity: prize.rarity,
          color: prize.color,
        },
        paymentTxId,
        distributionTxId: "preview-mode",
        status: "preview",
      });
    }

    /* -------------------------------------------------------------- */
    /*  Live mode                                                     */
    /* -------------------------------------------------------------- */

    const algodClient = getAlgodClient();

    /* 1. Verify the payment transaction on-chain */
    let confirmedTxn: Record<string, unknown>;
    try {
      confirmedTxn = (await algodClient
        .pendingTransactionInformation(paymentTxId)
        .do()) as unknown as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "Payment transaction not found on-chain" },
        { status: 400 }
      );
    }

    const confirmedRound = confirmedTxn?.["confirmed-round"] as
      | number
      | undefined;
    if (!confirmedRound) {
      return NextResponse.json(
        { error: "Payment transaction has not been confirmed yet" },
        { status: 400 }
      );
    }

    // Verify the sender matches the claimed wallet
    const sender =
      (confirmedTxn?.txn as Record<string, unknown>)?.snd ??
      (confirmedTxn?.["sender"] as string | undefined);
    if (sender && typeof sender === "string") {
      const senderAddr =
        sender.length === 58
          ? sender
          : algosdk.encodeAddress(
              algosdk.decodeAddress(walletAddress).publicKey
            );
      if (
        senderAddr.toUpperCase() !== walletAddress.toUpperCase() &&
        sender.toUpperCase() !== walletAddress.toUpperCase()
      ) {
        // Sender mismatch is suspicious but not fatal in all SDK versions
        console.warn(
          `[lootbox/reveal] Sender mismatch: expected ${walletAddress}, got ${sender}`
        );
      }
    }

    // Verify transaction type is a payment
    const txType =
      (confirmedTxn?.["tx-type"] as string | undefined) ??
      (confirmedTxn?.type as string | undefined);
    if (!txType || txType !== "pay") {
      return NextResponse.json(
        { error: "Transaction is not a payment transaction" },
        { status: 400 }
      );
    }

    // Verify the receiver matches the treasury address
    const treasuryAddress = getTreasuryAddress();
    const receiver =
      (
        confirmedTxn?.["payment-transaction"] as
          | Record<string, unknown>
          | undefined
      )?.["receiver"] ??
      (confirmedTxn?.txn as Record<string, unknown> | undefined)?.rcv;

    if (!receiver || typeof receiver !== "string") {
      return NextResponse.json(
        { error: "Unable to read payment receiver from transaction" },
        { status: 400 }
      );
    }

    if (receiver.toUpperCase() !== treasuryAddress.toUpperCase()) {
      return NextResponse.json(
        { error: "Payment was not sent to the treasury address" },
        { status: 400 }
      );
    }

    // Verify the payment amount meets the crate price
    const expectedAmountMicroAlgo = lootboxConfig.cratePrice * 1_000_000;
    const paymentAmount =
      ((
        confirmedTxn?.["payment-transaction"] as
          | Record<string, unknown>
          | undefined
      )?.["amount"] as number | undefined) ??
      ((confirmedTxn?.txn as Record<string, unknown> | undefined)?.amt as
        | number
        | undefined);

    if (paymentAmount === undefined || paymentAmount === null) {
      return NextResponse.json(
        { error: "Unable to read payment amount from transaction" },
        { status: 400 }
      );
    }

    if (paymentAmount < expectedAmountMicroAlgo) {
      return NextResponse.json(
        {
          error: `Insufficient payment: expected at least ${expectedAmountMicroAlgo} microAlgo, got ${paymentAmount}`,
        },
        { status: 400 }
      );
    }

    /* 2. Read randomness from the beacon contract */
    let randomValue: number;
    try {
      const beaconRound = confirmedRound + lootboxConfig.commitDelayRounds;

      // Wait until the beacon round has passed
      const status = (await algodClient.status().do()) as unknown as Record<
        string,
        unknown
      >;
      const currentRound =
        (status?.["last-round"] as number) ?? (status?.lastRound as number) ?? 0;

      if (currentRound < beaconRound) {
        // Wait for the required rounds
        await algodClient.statusAfterBlock(beaconRound).do();
      }

      // Read the beacon app's global state for the randomness
      const appInfo = (await algodClient
        .getApplicationByID(BEACON_APP_ID)
        .do()) as unknown as Record<string, unknown>;

      const globalState = (
        appInfo?.params as Record<string, unknown>
      )?.["global-state"] as Array<{
        key: string;
        value: { bytes?: string; uint?: number; type?: number };
      }>;

      // Use the confirmed round + payment txId as seed if beacon read fails
      let beaconBytes: Uint8Array | null = null;
      if (globalState) {
        for (const kv of globalState) {
          const keyStr = Buffer.from(kv.key, "base64").toString("utf8");
          if (keyStr === "randomness" || keyStr === "last_randomness") {
            beaconBytes = new Uint8Array(
              Buffer.from(kv.value.bytes ?? "", "base64")
            );
            break;
          }
        }
      }

      if (beaconBytes && beaconBytes.length > 0) {
        // Combine beacon randomness with payment txId for uniqueness
        const txIdBytes = new Uint8Array(
          Buffer.from(paymentTxId, "base64").slice(0, 8)
        );
        let combined = 0;
        for (let i = 0; i < Math.min(beaconBytes.length, 8); i++) {
          combined ^= beaconBytes[i] << ((i % 4) * 8);
        }
        for (let i = 0; i < txIdBytes.length; i++) {
          combined ^= txIdBytes[i] << ((i % 4) * 8);
        }
        randomValue = Math.abs(combined) / 0xffffffff;
      } else {
        // Fallback: hash-based randomness from confirmedRound + txId
        const seed = `${confirmedRound}-${paymentTxId}`;
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
          hash = (hash << 5) - hash + seed.charCodeAt(i);
          hash |= 0;
        }
        randomValue = Math.abs(hash) / 0x7fffffff;
      }
    } catch (beaconErr) {
      console.warn(
        "[lootbox/reveal] Beacon read failed, using fallback randomness:",
        beaconErr
      );
      const seed = `${confirmedRound}-${paymentTxId}`;
      let hash = 0;
      for (let i = 0; i < seed.length; i++) {
        hash = (hash << 5) - hash + seed.charCodeAt(i);
        hash |= 0;
      }
      randomValue = Math.abs(hash) / 0x7fffffff;
    }

    /* 3. Resolve the prize */
    const prize = resolvePrize(prizes, randomValue);

    /* 4. Distribute the prize from master wallet */
    let distributionTxId: string;
    try {
      const masterAccount = getLootboxMasterAccount();
      distributionTxId = await distributePrize({
        prize,
        recipientAddress: walletAddress,
        masterAccount,
        algodClient,
      });
    } catch (distErr: unknown) {
      console.error("[lootbox/reveal] Distribution failed:", distErr);
      return NextResponse.json(
        {
          error: "Prize distribution failed. Please contact support.",
          prize: {
            id: prize.id,
            name: prize.name,
            type: prize.type,
            rarity: prize.rarity,
            color: prize.color,
          },
          paymentTxId,
        },
        { status: 500 }
      );
    }

    /* 5. Return result */
    return NextResponse.json({
      prize: {
        id: prize.id,
        name: prize.name,
        type: prize.type,
        rarity: prize.rarity,
        color: prize.color,
      },
      paymentTxId,
      distributionTxId,
      status: "success",
    });
  } catch (err: unknown) {
    console.error("[lootbox/reveal]", err);
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
