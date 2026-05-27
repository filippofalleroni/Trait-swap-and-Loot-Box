"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  | "signing"
  | "waiting-vrf"
  | "revealing"
  | "distributing"
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
  commitRound: number;
  revealTxId?: string;
}

const PENDING_KEY = "lootbox_pending_reveal";
const MAX_GROUP_SIZE = 16;
const MIN_WAIT_ROUNDS = 9;

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
  const [prizesLoaded, setPrizesLoaded] = useState(false);
  const [result, setResult] = useState<RevealResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPrizes, setShowPrizes] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [cratesOpened, setCratesOpened] = useState(0);
  const [buyerBalance, setBuyerBalance] = useState<number | null>(null);
  const [vrfProgress, setVrfProgress] = useState("");
  const processingRef = useRef(false);
  const [pendingReveal, setPendingReveal] = useState<PendingReveal | null>(
    () => {
      if (typeof window === "undefined") return null;
      try {
        const stored = sessionStorage.getItem(PENDING_KEY);
        return stored ? JSON.parse(stored) : null;
      } catch {
        return null;
      }
    }
  );

  /* ---------------------------------------------------------------- */
  /*  Sync pendingReveal to sessionStorage                            */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    try {
      if (pendingReveal) {
        sessionStorage.setItem(PENDING_KEY, JSON.stringify(pendingReveal));
      } else {
        sessionStorage.removeItem(PENDING_KEY);
      }
    } catch {
      // sessionStorage not available
    }
  }, [pendingReveal]);

  /* ---------------------------------------------------------------- */
  /*  Load prizes                                                     */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    fetch("/api/lootbox/prizes")
      .then((r) => r.json())
      .then((data) => {
        if (data.prizes) setPrizes(data.prizes);
        setPrizesLoaded(true);
      })
      .catch(() => {
        setPrizes(lootboxConfig.prizes);
        setPrizesLoaded(true);
      });
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Load buyer balance (community fund)                             */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    async function loadBalance() {
      try {
        const res = await fetch("/api/lootbox/buyer-balance");
        if (res.ok) {
          const d = await res.json();
          setBuyerBalance(d.balanceAlgo ?? 0);
        }
      } catch {
        // non-critical
      }
    }
    void loadBalance();
    const interval = setInterval(loadBalance, 30_000);
    return () => clearInterval(interval);
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Prize list grouped by rarity                                    */
  /* ---------------------------------------------------------------- */

  const groupedPrizes = useMemo(() => {
    const groups: Partial<Record<PrizeRarity, PrizeTier[]>> = {};
    prizes.forEach((p) => {
      if (!groups[p.rarity]) groups[p.rarity] = [];
      groups[p.rarity]!.push(p);
    });
    return groups;
  }, [prizes]);

  const computedTotalWeight = useMemo(
    () => prizes.reduce((sum, p) => sum + p.weight, 0) || totalPrizeWeight,
    [prizes]
  );

  /* ---------------------------------------------------------------- */
  /*  Wait for VRF rounds to pass                                     */
  /* ---------------------------------------------------------------- */

  async function waitForVrfRounds(
    algodClient: algosdk.Algodv2,
    commitRound: number
  ): Promise<void> {
    const targetRound = commitRound + MIN_WAIT_ROUNDS;
    for (let i = 0; i < 30; i++) {
      const status = (await algodClient.status().do()) as unknown as Record<string, unknown>;
      const currentRound = Number(status["last-round"] ?? 0);
      if (currentRound >= targetRound) return;
      const remaining = targetRound - currentRound;
      setVrfProgress(`Waiting for randomness... ${remaining} round${remaining === 1 ? "" : "s"} remaining`);
      await new Promise(function (resolve) {
        setTimeout(resolve, 3000);
      });
    }
    throw new Error("Timed out waiting for VRF rounds.");
  }

  /* ---------------------------------------------------------------- */
  /*  Build, sign, and submit the on-chain reveal                     */
  /* ---------------------------------------------------------------- */

  async function submitOnChainReveal(
    algodClient: algosdk.Algodv2,
    address: string
  ): Promise<string> {
    const buildRes = await fetch("/api/lootbox/build-reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: address }),
    });

    if (!buildRes.ok) {
      const errData = await buildRes.json().catch(() => ({}));
      throw new Error(errData.error || "Failed to build reveal transaction");
    }

    const { unsignedTxn } = await buildRes.json();
    if (typeof unsignedTxn !== "string") {
      throw new Error("Server returned an invalid reveal response.");
    }

    const decoded = algosdk.decodeUnsignedTransaction(
      new Uint8Array(Buffer.from(unsignedTxn, "base64"))
    );
    const encoded = algosdk.encodeUnsignedTransaction(decoded);
    const signedArr = await signTransactions!([encoded]);
    const signed = signedArr.filter((s): s is Uint8Array => s !== null);

    const { txid } = await algodClient.sendRawTransaction(signed).do();
    await algosdk.waitForConfirmation(algodClient, txid as string, 10);

    return txid as string;
  }

  /* ---------------------------------------------------------------- */
  /*  Server reveal call (distributes prize)                          */
  /* ---------------------------------------------------------------- */

  const callServerReveal = useCallback(
    async (address: string, paymentTxId: string, revealTxId?: string) => {
      setState("distributing");

      const res = await fetch("/api/lootbox/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address, paymentTxId, revealTxId }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({} as Record<string, unknown>));
        // 409 means the server already processed this — the user likely got
        // their prize but the response was lost. Treat as success if the
        // server included prize info, otherwise show a clear message.
        if (res.status === 409) {
          setPendingReveal(null);
          setState("idle");
          setShowModal(false);
          return;
        }
        throw new Error((errData as Record<string, string>).error || `Reveal failed (${res.status})`);
      }

      const data: RevealResult = await res.json();
      setPendingReveal(null);
      setResult(data);
      setState("success");
      setCratesOpened((c) => c + 1);

      fetch("/api/lootbox/prizes")
        .then((r) => r.json())
        .then((d) => { if (d.prizes) setPrizes(d.prizes); })
        .catch(() => {});
    },
    []
  );

  /* ---------------------------------------------------------------- */
  /*  Open Loot Box handler                                           */
  /* ---------------------------------------------------------------- */

  const handleOpenLootBox = useCallback(async () => {
    if (!walletAddress || !signTransactions) return;
    if (processingRef.current) return;
    processingRef.current = true;

    setError(null);
    setResult(null);
    setState("committing");
    setShowModal(true);

    let commitSubmitted = false;

    try {
      const algodClient = new algosdk.Algodv2("", ALGOD_BASE_URL, "");

      // Check if we have a pending reveal to resume
      const retrying =
        pendingReveal && pendingReveal.walletAddress === walletAddress;

      // Check if the pending reveal is too old to be useful (> 900 rounds ~ 45 min)
      if (retrying && pendingReveal.commitRound > 0) {
        const status = (await algodClient.status().do()) as unknown as Record<string, unknown>;
        const currentRound = Number(status["last-round"] ?? 0);
        if (currentRound > pendingReveal.commitRound + 900) {
          setPendingReveal(null);
          throw new Error("Your previous session expired. Please open a new loot box.");
        }
        commitSubmitted = true;
      }

      // If we already have a revealTxId, skip straight to server call
      if (retrying && pendingReveal.revealTxId) {
        await callServerReveal(
          walletAddress,
          pendingReveal.paymentTxId,
          pendingReveal.revealTxId
        );
        return;
      }

      // If we have a commit but no reveal yet, skip to VRF wait + reveal
      if (retrying && pendingReveal.commitRound > 0) {
        setState("waiting-vrf");
        setShowModal(true);
        await waitForVrfRounds(algodClient, pendingReveal.commitRound);

        setState("revealing");
        const revealTxId = await submitOnChainReveal(algodClient, walletAddress);
        setPendingReveal((prev) => prev ? { ...prev, revealTxId } : null);

        await callServerReveal(walletAddress, pendingReveal.paymentTxId, revealTxId);
        return;
      }

      /* --- Fresh loot box open --- */

      /* 1. Fetch account info for opt-in check */
      let accountInfo: Record<string, unknown> = {};
      try {
        accountInfo = (await algodClient
          .accountInformation(walletAddress)
          .do()) as unknown as Record<string, unknown>;
      } catch {
        // Account may not exist yet
      }

      const heldAssets = new Set<number>();
      const assets =
        accountInfo?.assets ?? accountInfo?.["created-assets"] ?? [];
      if (Array.isArray(assets)) {
        assets.forEach((a: Record<string, unknown>) => {
          const id = a?.["asset-id"] ?? a?.assetId;
          if (typeof id === "number") heldAssets.add(id);
          else if (typeof id === "bigint") heldAssets.add(Number(id));
        });
      }

      /* 2. Determine which prize assets need opt-in */
      const uniqueAssetIds = Array.from(
        new Set(
          prizes.map((p) => p.assetId).filter((id) => id > 0)
        )
      );
      const needsOptIn = uniqueAssetIds.filter((id) => !heldAssets.has(id));

      /* 3. Build opt-in transactions in groups of MAX_GROUP_SIZE */
      const suggestedParams = await algodClient.getTransactionParams().do();
      const optInGroups: algosdk.Transaction[][] = [];
      for (let i = 0; i < needsOptIn.length; i += MAX_GROUP_SIZE) {
        const batch = needsOptIn.slice(i, i + MAX_GROUP_SIZE);
        const txns = batch.map((assetId) =>
          algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
            sender: walletAddress,
            receiver: walletAddress,
            assetIndex: assetId,
            amount: 0,
            suggestedParams,
          })
        );
        if (txns.length > 1) algosdk.assignGroupID(txns);
        optInGroups.push(txns);
      }

      /* 4. Build commit transactions */
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
      if (!Array.isArray(commitData.txIds) || commitData.txIds.length === 0 ||
          !Array.isArray(commitData.unsignedTxns) || commitData.unsignedTxns.length === 0) {
        throw new Error("Server returned an invalid commit response.");
      }
      const isLive = commitData.mode === "live";

      const paymentTxns = (commitData.unsignedTxns as string[]).map(
        (b64: string) =>
          algosdk.decodeUnsignedTransaction(
            new Uint8Array(Buffer.from(b64, "base64"))
          )
      );

      /* 5. Combine all transactions for a single wallet prompt */
      const allOptInTxns = ([] as algosdk.Transaction[]).concat(
        ...optInGroups
      );
      const allTxns = [...allOptInTxns, ...paymentTxns];

      if (allTxns.length === 0) {
        throw new Error("No transactions to sign.");
      }

      const encodedForWallet = allTxns.map((txn) =>
        algosdk.encodeUnsignedTransaction(txn)
      );

      setState("signing");
      const signedAll = await signTransactions(encodedForWallet);
      if (signedAll.length !== encodedForWallet.length) {
        throw new Error("Wallet returned unexpected number of signed transactions.");
      }
      const signedFiltered = signedAll.map(function (s) {
        if (!s) throw new Error("Wallet declined to sign a required transaction.");
        return s;
      });

      /* 6. Submit each opt-in group sequentially, then commit group */
      let offset = 0;
      for (let g = 0; g < optInGroups.length; g++) {
        const group = optInGroups[g];
        const groupSigned = signedFiltered.slice(
          offset,
          offset + group.length
        );
        const { txid } = await algodClient
          .sendRawTransaction(groupSigned)
          .do();
        await algosdk.waitForConfirmation(
          algodClient,
          txid as string,
          4
        );
        offset += group.length;
      }

      /* 7. Submit commit group */
      const commitSigned = signedFiltered.slice(
        offset,
        offset + paymentTxns.length
      );
      const { txid: commitTxid } = await algodClient
        .sendRawTransaction(commitSigned)
        .do();
      const confirmResult = (await algosdk.waitForConfirmation(
        algodClient,
        commitTxid as string,
        10
      )) as unknown as Record<string, unknown>;

      commitSubmitted = true;
      const paymentTxId = commitData.txIds[0] as string;
      const commitRound = Number(confirmResult["confirmed-round"] ?? 0);

      // Save pending state for crash recovery
      const pending: PendingReveal = {
        walletAddress,
        paymentTxId,
        commitRound,
      };
      setPendingReveal(pending);

      if (!isLive) {
        // Preview mode: no on-chain reveal needed, call server directly
        await callServerReveal(walletAddress, paymentTxId);
        return;
      }

      /* 8. Wait for VRF rounds */
      setState("waiting-vrf");
      await waitForVrfRounds(algodClient, commitRound);

      /* 9. Build, sign, and submit on-chain reveal */
      setState("revealing");
      const revealTxId = await submitOnChainReveal(algodClient, walletAddress);
      setPendingReveal((prev) => prev ? { ...prev, revealTxId } : null);

      /* 10. Send to server for prize distribution */
      await callServerReveal(walletAddress, paymentTxId, revealTxId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong";

      if (
        msg.toLowerCase().includes("user rejected") ||
        msg.toLowerCase().includes("cancelled") ||
        msg.toLowerCase().includes("canceled")
      ) {
        // Only clear pendingReveal if the commit hasn't been submitted yet.
        // If the user cancels the reveal signing after paying, they need
        // pendingReveal to retry and claim their prize.
        if (!commitSubmitted) {
          setPendingReveal(null);
        }
        setState("idle");
        setShowModal(false);
        return;
      }

      setError(msg);
      setState("error");
    } finally {
      processingRef.current = false;
    }
  }, [walletAddress, prizes, signTransactions, callServerReveal, pendingReveal]);

  /* ---------------------------------------------------------------- */
  /*  Retry handler                                                   */
  /* ---------------------------------------------------------------- */

  const handleRetry = useCallback(() => {
    if (pendingReveal && walletAddress) {
      setError(null);
      setResult(null);
      handleOpenLootBox();
      return;
    }
    setState("idle");
    setError(null);
    setResult(null);
    setShowModal(false);
  }, [walletAddress, pendingReveal, handleOpenLootBox]);

  /* ---------------------------------------------------------------- */
  /*  Close modal                                                     */
  /* ---------------------------------------------------------------- */

  const closeModal = useCallback(() => {
    setShowModal(false);
    if (state === "success") {
      setPendingReveal(null);
    }
    setState("idle");
    setResult(null);
    setError(null);
  }, [state]);

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */

  const isProcessing =
    state === "committing" ||
    state === "signing" ||
    state === "waiting-vrf" ||
    state === "revealing" ||
    state === "distributing";

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
        {cratesOpened > 0 && (
          <p className="mt-1 text-xs text-zinc-500">
            Opened this session: {cratesOpened}
          </p>
        )}
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
            {state === "signing" && (
              <p className="text-sm text-zinc-400">
                Approve the transaction in your wallet...
              </p>
            )}
            {state === "waiting-vrf" && (
              <p className="text-sm text-zinc-400">
                {vrfProgress || "Waiting for on-chain randomness..."}
              </p>
            )}
            {state === "revealing" && (
              <p className="text-sm text-zinc-400">
                Approve the reveal transaction...
              </p>
            )}
            {state === "distributing" && (
              <p className="text-sm text-zinc-400">
                Distributing your prize...
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
              disabled={
                isProcessing ||
                !walletAddress ||
                (!prizesLoaded && !pendingReveal)
              }
              className="rounded-xl bg-indigo-600 px-8 py-3 text-base font-semibold text-white transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!walletAddress
                ? "Connect Wallet"
                : isProcessing
                ? "Processing..."
                : pendingReveal
                ? "Retry Loot Box"
                : !prizesLoaded
                ? "Loading..."
                : "Open Loot Box"}
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
        {/*  Sidebar — Balance + Prize list                          */}
        {/* -------------------------------------------------------- */}
        <div className="lg:col-span-2 space-y-4">
          {/* Community Fund Balance */}
          {buyerBalance !== null && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-5 py-4">
              <p className="text-xs uppercase tracking-wide text-zinc-500">
                Community Fund
              </p>
              <p className="mt-1 text-lg font-bold tabular-nums text-indigo-400">
                {buyerBalance.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}{" "}
                <span className="text-xs font-normal text-zinc-500">
                  ALGO
                </span>
              </p>
            </div>
          )}
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
                    ).toFixed(2);
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
            {state === "signing" && (
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

            {/* Waiting for VRF randomness */}
            {state === "waiting-vrf" && (
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-amber-500 border-t-transparent" />
                <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">
                  Generating Randomness
                </p>
                <p className="text-sm text-zinc-400">
                  {vrfProgress || "Waiting for on-chain VRF seed..."}
                </p>
                <p className="text-xs text-zinc-600">
                  This takes about 30 seconds
                </p>
              </div>
            )}

            {/* Revealing state */}
            {state === "revealing" && (
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="h-12 w-12 animate-pulse rounded-full border-4 border-indigo-400/50 bg-indigo-500/10" />
                <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
                  Reveal
                </p>
                <p className="text-sm text-zinc-400">
                  Approve the reveal transaction in your wallet...
                </p>
              </div>
            )}

            {/* Distributing state */}
            {state === "distributing" && (
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
                <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
                  Distributing Prize
                </p>
                <p className="text-sm text-zinc-400">
                  Sending your prize...
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
                {pendingReveal && (
                  <div className="w-full rounded-lg border border-emerald-900/30 bg-emerald-950/20 px-4 py-2.5">
                    <p className="text-xs text-emerald-400/80">
                      Your payment went through. Tap Retry to claim your
                      prize — you will not be charged again.
                    </p>
                  </div>
                )}
                <div className="grid w-full grid-cols-2 gap-3">
                  <button
                    onClick={closeModal}
                    className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
                  >
                    Close
                  </button>
                  <button
                    onClick={handleRetry}
                    className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
                  >
                    {pendingReveal ? "Retry" : "Try Again"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
