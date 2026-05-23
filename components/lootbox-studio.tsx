"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import algosdk from "algosdk";
import { useWallet } from "@/contexts/wallet-context";
import { lootboxConfig, RARITY_COLORS, totalPrizeWeight } from "@/config/lootbox";
import { ALGOD_BASE_URL } from "@/lib/algorand";
import type { PrizeTier, PrizeRarity } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type LootboxState =
  | "idle"
  | "committing"
  | "waiting"
  | "revealing"
  | "success"
  | "error";

interface RevealResult {
  prize: {
    id: string;
    name: string;
    type: string;
    rarity: PrizeRarity;
    color: string;
  };
  paymentTxId: string;
  distributionTxId: string;
  status: string;
}

interface PendingReveal {
  walletAddress: string;
  paymentTxId: string;
}

const PENDING_KEY = "lootbox_pending_reveal";

/* ------------------------------------------------------------------ */
/*  Rarity helpers                                                    */
/* ------------------------------------------------------------------ */

const RARITY_ORDER: PrizeRarity[] = [
  "legendary",
  "epic",
  "rare",
  "uncommon",
  "common",
];

const RARITY_BG: Record<PrizeRarity, string> = {
  common: "bg-zinc-500/10 border-zinc-500/30",
  uncommon: "bg-emerald-500/10 border-emerald-500/30",
  rare: "bg-blue-500/10 border-blue-500/30",
  epic: "bg-violet-500/10 border-violet-500/30",
  legendary: "bg-amber-500/10 border-amber-500/30",
};

const RARITY_GLOW: Record<PrizeRarity, string> = {
  common: "",
  uncommon: "shadow-emerald-500/20",
  rare: "shadow-blue-500/20",
  epic: "shadow-violet-500/30",
  legendary: "shadow-amber-500/40 shadow-lg",
};

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function LootboxStudio() {
  const { walletAddress, signTransactions } = useWallet();

  const [state, setState] = useState<LootboxState>("idle");
  const [prizes, setPrizes] = useState<PrizeTier[]>([]);
  const [result, setResult] = useState<RevealResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPrizes, setShowPrizes] = useState(false);
  const [showModal, setShowModal] = useState(false);

  /* ---------------------------------------------------------------- */
  /*  Load prizes                                                     */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    fetch("/api/lootbox/prizes")
      .then((r) => r.json())
      .then((data) => {
        if (data.prizes) setPrizes(data.prizes);
      })
      .catch(() => {
        // Fallback to config prizes
        setPrizes(lootboxConfig.prizes);
      });
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Recover pending reveal from sessionStorage                      */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!walletAddress) return;

    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return;

      const pending: PendingReveal = JSON.parse(raw);
      if (pending.walletAddress !== walletAddress) return;

      // Attempt to complete the reveal
      handleReveal(pending.walletAddress, pending.paymentTxId);
    } catch {
      sessionStorage.removeItem(PENDING_KEY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  /* ---------------------------------------------------------------- */
  /*  Prize list grouped by rarity                                    */
  /* ---------------------------------------------------------------- */

  const groupedPrizes = useMemo(() => {
    const groups: Partial<Record<PrizeRarity, PrizeTier[]>> = {};
    for (const p of prizes) {
      if (!groups[p.rarity]) groups[p.rarity] = [];
      groups[p.rarity]!.push(p);
    }
    return groups;
  }, [prizes]);

  const computedTotalWeight = useMemo(
    () => prizes.reduce((sum, p) => sum + p.weight, 0) || totalPrizeWeight,
    [prizes]
  );

  /* ---------------------------------------------------------------- */
  /*  Reveal handler                                                  */
  /* ---------------------------------------------------------------- */

  const handleReveal = useCallback(
    async (address: string, paymentTxId: string) => {
      setState("revealing");
      setShowModal(true);

      try {
        const res = await fetch("/api/lootbox/reveal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddress: address, paymentTxId }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Reveal failed (${res.status})`);
        }

        const data: RevealResult = await res.json();
        setResult(data);
        setState("success");
        sessionStorage.removeItem(PENDING_KEY);

        // Refresh prizes (one-time prizes may have been removed)
        fetch("/api/lootbox/prizes")
          .then((r) => r.json())
          .then((d) => { if (d.prizes) setPrizes(d.prizes); })
          .catch(() => {});
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Reveal failed";
        setError(msg);
        setState("error");
      }
    },
    []
  );

  /* ---------------------------------------------------------------- */
  /*  Open Loot Box handler                                           */
  /* ---------------------------------------------------------------- */

  const handleOpenLootBox = useCallback(async () => {
    if (!walletAddress) return;

    setError(null);
    setResult(null);
    setState("committing");
    setShowModal(true);

    try {
      /* 1. Fetch prize list for opt-in check */
      const prizesRes = await fetch("/api/lootbox/prizes");
      const prizesData = await prizesRes.json();
      const prizeList: PrizeTier[] = prizesData.prizes ?? prizes;

      /* 2. Check which prize assets need opt-in */
      const uniqueAssetIds = Array.from(
        new Set(prizeList.map((p) => p.assetId).filter((id) => id > 0))
      );

      const algodClient = new algosdk.Algodv2("", ALGOD_BASE_URL, "");
      let accountInfo: Record<string, unknown> = {};

      try {
        accountInfo = await algodClient.accountInformation(walletAddress).do() as unknown as Record<string, unknown>;
      } catch {
        // Account may not exist yet
      }

      const heldAssets = new Set<number>();
      const assets = accountInfo?.assets ?? accountInfo?.["created-assets"] ?? [];
      if (Array.isArray(assets)) {
        for (const a of assets) {
          const id = a?.["asset-id"] ?? a?.assetId;
          if (typeof id === "number") heldAssets.add(id);
        }
      }

      const needsOptIn = uniqueAssetIds.filter((id) => !heldAssets.has(id));

      /* 3. Get unsigned commit/payment transaction from API */
      const commitRes = await fetch("/api/lootbox/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });

      if (!commitRes.ok) {
        const errData = await commitRes.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to build transaction");
      }

      const commitData = await commitRes.json();
      const { unsignedTxns, txIds } = commitData as {
        unsignedTxns: string[];
        txIds: string[];
      };

      /* 4. Build opt-in transactions if needed */
      const suggestedParams = await algodClient.getTransactionParams().do();
      const optInTxns: algosdk.Transaction[] = needsOptIn.map((assetId) =>
        algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          sender: walletAddress,
          receiver: walletAddress,
          assetIndex: assetId,
          amount: 0,
          suggestedParams,
        })
      );

      if (optInTxns.length > 1) {
        algosdk.assignGroupID(optInTxns);
      }

      /* 5. Decode commit/payment txns (these already have their own group ID) */
      const paymentTxns = unsignedTxns.map((b64: string) =>
        algosdk.decodeUnsignedTransaction(
          new Uint8Array(Buffer.from(b64, "base64"))
        )
      );

      /* 6. Sign all transactions in one wallet prompt */
      const allTxns = [...optInTxns, ...paymentTxns];
      const encodedForWallet = allTxns.map((txn) =>
        algosdk.encodeUnsignedTransaction(txn)
      );

      setState("waiting");
      const signedAll = await signTransactions(encodedForWallet);
      const signedFiltered = signedAll.filter(
        (s): s is Uint8Array => s !== null
      );

      /* 7. Submit opt-ins first (separately from payment) */
      let offset = 0;
      if (optInTxns.length > 0) {
        const optInSigned = signedFiltered.slice(0, optInTxns.length);
        const { txid } = await algodClient
          .sendRawTransaction(optInSigned)
          .do();
        await algosdk.waitForConfirmation(algodClient, txid, 4);
        offset = optInTxns.length;
      }

      /* 8. Submit payment/commit transaction(s) */
      const paymentSigned = signedFiltered.slice(
        offset,
        offset + paymentTxns.length
      );
      const { txid: payTxid } = await algodClient
        .sendRawTransaction(paymentSigned)
        .do();
      await algosdk.waitForConfirmation(algodClient, payTxid, 10);

      const paymentTxId = (txIds[0] as string) ?? payTxid;

      /* 9. Save pending reveal for recovery */
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ walletAddress, paymentTxId })
      );

      /* 12. Reveal */
      await handleReveal(walletAddress, paymentTxId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      // Don't overwrite a pending reveal error
      if (state !== "revealing") {
        setError(msg);
        setState("error");
      }
    }
  }, [walletAddress, prizes, signTransactions, handleReveal, state]);

  /* ---------------------------------------------------------------- */
  /*  Retry handler                                                   */
  /* ---------------------------------------------------------------- */

  const handleRetry = useCallback(() => {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (raw && walletAddress) {
      try {
        const pending: PendingReveal = JSON.parse(raw);
        if (pending.walletAddress === walletAddress) {
          handleReveal(pending.walletAddress, pending.paymentTxId);
          return;
        }
      } catch {
        // fall through
      }
    }
    setState("idle");
    setError(null);
    setResult(null);
    setShowModal(false);
  }, [walletAddress, handleReveal]);

  /* ---------------------------------------------------------------- */
  /*  Close modal                                                     */
  /* ---------------------------------------------------------------- */

  const closeModal = useCallback(() => {
    setShowModal(false);
    setState("idle");
    setResult(null);
    setError(null);
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */

  const isProcessing =
    state === "committing" || state === "waiting" || state === "revealing";

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-zinc-100">Loot Box</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Open a loot box for a chance to win prizes. Cost:{" "}
          <span className="font-semibold text-indigo-400">
            {lootboxConfig.cratePrice} ALGO
          </span>
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-5">
        {/* -------------------------------------------------------- */}
        {/*  Main panel — Loot box CTA                               */}
        {/* -------------------------------------------------------- */}
        <div className="lg:col-span-3">
          <div className="flex flex-col items-center gap-6 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-10">
            {/* Crate visual */}
            <div className="relative flex h-40 w-40 items-center justify-center rounded-2xl border-2 border-indigo-500/30 bg-gradient-to-br from-indigo-950/60 to-violet-950/60">
              <div className="text-6xl select-none" aria-hidden="true">
                {isProcessing ? (
                  <span className="inline-block animate-bounce">?</span>
                ) : (
                  <span>&#x1F4E6;</span>
                )}
              </div>
              {isProcessing && (
                <div className="absolute inset-0 animate-pulse rounded-2xl border-2 border-indigo-400/40" />
              )}
            </div>

            {/* Status text */}
            {state === "committing" && (
              <p className="text-sm text-zinc-400">
                Building transaction...
              </p>
            )}
            {state === "waiting" && (
              <p className="text-sm text-zinc-400">
                Approve the transaction in your wallet...
              </p>
            )}
            {state === "idle" && (
              <p className="text-sm text-zinc-500">
                Click below to open a loot box
              </p>
            )}

            {/* Open button */}
            <button
              onClick={handleOpenLootBox}
              disabled={isProcessing || !walletAddress}
              className="rounded-xl bg-indigo-600 px-8 py-3 text-base font-semibold text-white transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isProcessing ? "Processing..." : "Open Loot Box"}
            </button>

            {/* Error inline */}
            {state === "error" && error && !showModal && (
              <div className="w-full rounded-lg border border-red-900/40 bg-red-950/30 p-4 text-center">
                <p className="text-sm text-red-400">{error}</p>
                <button
                  onClick={handleRetry}
                  className="mt-3 rounded-md bg-zinc-800 px-4 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>

        {/* -------------------------------------------------------- */}
        {/*  Sidebar — Prize list                                    */}
        {/* -------------------------------------------------------- */}
        <div className="lg:col-span-2">
          <button
            onClick={() => setShowPrizes(!showPrizes)}
            className="flex w-full items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/70 px-5 py-3 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800/60 lg:hidden"
          >
            Prize Table
            <span className="text-zinc-500">
              {showPrizes ? "▲" : "▼"}
            </span>
          </button>

          <div
            className={`mt-2 space-y-3 lg:mt-0 lg:block ${
              showPrizes ? "block" : "hidden lg:block"
            }`}
          >
            <h2 className="hidden text-sm font-semibold uppercase tracking-wider text-zinc-500 lg:block">
              Prizes
            </h2>

            {RARITY_ORDER.map((rarity) => {
              const group = groupedPrizes[rarity];
              if (!group || group.length === 0) return null;

              return (
                <div key={rarity} className="space-y-1.5">
                  <h3
                    className="text-xs font-semibold uppercase tracking-wider"
                    style={{ color: RARITY_COLORS[rarity] }}
                  >
                    {rarity}
                  </h3>
                  {group.map((prize) => {
                    const chance = (
                      (prize.weight / computedTotalWeight) *
                      100
                    ).toFixed(1);
                    return (
                      <div
                        key={prize.id}
                        className={`flex items-center justify-between rounded-lg border px-3 py-2 ${RARITY_BG[rarity]}`}
                      >
                        <span className="text-sm text-zinc-200">
                          {prize.name}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {chance}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------ */}
      {/*  Reveal modal                                                */}
      {/* ------------------------------------------------------------ */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="relative mx-4 w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-8">
            {/* Close button */}
            {(state === "success" || state === "error") && (
              <button
                onClick={closeModal}
                className="absolute right-4 top-4 text-zinc-500 hover:text-zinc-300"
                aria-label="Close"
              >
                &#x2715;
              </button>
            )}

            {/* Committing state */}
            {state === "committing" && (
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
                <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
                  Building Transaction
                </p>
                <p className="text-sm text-zinc-400">
                  Preparing your loot box transaction...
                </p>
              </div>
            )}

            {/* Waiting for wallet approval */}
            {state === "waiting" && (
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="h-12 w-12 animate-pulse rounded-full border-4 border-indigo-400/50 bg-indigo-500/10" />
                <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
                  Confirm Payment
                </p>
                <p className="text-sm text-zinc-400">
                  Please approve the transaction in your wallet.
                </p>
                <div className="mt-2 w-full rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-center">
                  <p className="text-sm text-zinc-300">
                    Cost: <span className="font-semibold text-zinc-100">{lootboxConfig.cratePrice} ALGO</span>
                  </p>
                </div>
              </div>
            )}

            {/* Revealing state */}
            {state === "revealing" && (
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
                <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
                  Revealing Prize
                </p>
                <p className="text-sm text-zinc-400">
                  Opening your loot box...
                </p>
              </div>
            )}

            {/* Success state */}
            {state === "success" && result && (
              <div className="flex flex-col items-center gap-5 text-center">
                <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
                  Prize Revealed
                </p>

                <div
                  className={`flex h-24 w-24 items-center justify-center rounded-2xl border-2 ${
                    RARITY_BG[result.prize.rarity]
                  } ${RARITY_GLOW[result.prize.rarity]}`}
                >
                  <span className="text-4xl select-none">
                    {result.prize.rarity === "legendary"
                      ? "⭐"
                      : result.prize.rarity === "epic"
                      ? "✨"
                      : result.prize.rarity === "rare"
                      ? "\u{1F48E}"
                      : "\u{1F381}"}
                  </span>
                </div>

                <div>
                  <p
                    className="text-xs font-semibold uppercase tracking-widest"
                    style={{ color: result.prize.color }}
                  >
                    {result.prize.rarity}
                  </p>
                  <h3 className="mt-1 text-xl font-bold text-zinc-100">
                    {result.prize.name}
                  </h3>
                </div>

                {result.status === "preview" && (
                  <p className="rounded-lg bg-zinc-800/60 px-3 py-1.5 text-[10px] uppercase tracking-widest text-zinc-500">
                    Preview mode — prizes not distributed
                  </p>
                )}

                {result.distributionTxId &&
                  result.distributionTxId !== "preview-mode" && (
                    <a
                      href={`https://allo.info/tx/${result.distributionTxId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-400 underline underline-offset-2 hover:text-indigo-300"
                    >
                      View distribution transaction
                    </a>
                  )}

                <div className="mt-2 grid w-full grid-cols-2 gap-3">
                  <button
                    onClick={closeModal}
                    className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors"
                  >
                    Close
                  </button>
                  <button
                    onClick={() => {
                      closeModal();
                      setTimeout(() => handleOpenLootBox(), 300);
                    }}
                    className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors"
                  >
                    Play Again
                  </button>
                </div>
              </div>
            )}

            {/* Error state */}
            {state === "error" && (
              <div className="flex flex-col items-center gap-4 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-red-900/40 bg-red-950/30">
                  <span className="text-2xl">&#x26A0;</span>
                </div>
                <p className="text-sm text-red-400">
                  {error || "Something went wrong"}
                </p>
                <button
                  onClick={handleRetry}
                  className="rounded-lg bg-zinc-800 px-5 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
