"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import algosdk from "algosdk";
import { useWallet } from "@/contexts/wallet-context";
import { RARITY_COLORS } from "@/config/lootbox";
import { ALGOD_BASE_URL } from "@/lib/algorand";
import {
  adminGetChallenge,
  adminCreateSession,
  adminGetPrizes,
  adminSavePrizes,
  adminGetRevenue,
  adminGetBuyerNfts,
  adminOptIn,
} from "@/app/actions/admin";
import type { PrizeTier, PrizeRarity } from "@/lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RARITY_OPTIONS: PrizeRarity[] = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
];

const EMPTY_PRIZE: PrizeTier = {
  id: "",
  name: "",
  type: "token",
  assetId: 0,
  amount: 0,
  weight: 1,
  rarity: "common",
  color: RARITY_COLORS.common,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function LootboxAdmin() {
  const { walletAddress, signTransactions } = useWallet();

  // Auth state
  const [authenticated, setAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Prizes state
  const [prizes, setPrizes] = useState<PrizeTier[]>([]);
  const [saving, setSaving] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<PrizeTier>(EMPTY_PRIZE);

  // Revenue state
  const [revenue, setRevenue] = useState<{
    treasuryBalanceMicroAlgo: number;
    masterWalletBalanceMicroAlgo: number;
    cratePrice: number;
  } | null>(null);

  // NFT inventory state
  const [nfts, setNfts] = useState<
    { assetId: number; amount: number; name?: string }[]
  >([]);

  // Opt-in state
  const [optInAssetId, setOptInAssetId] = useState("");
  const [optInLoading, setOptInLoading] = useState(false);
  const [optInMessage, setOptInMessage] = useState<string | null>(null);

  // Status message
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Revenue auto-refresh interval ref
  const revenueIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );

  // ---------------------------------------------------------------------------
  // Authentication: challenge -> sign -> session
  // ---------------------------------------------------------------------------
  const authenticate = useCallback(async () => {
    if (!walletAddress) return;
    setAuthLoading(true);
    setAuthError(null);

    try {
      // 1. Get a challenge nonce from the server.
      const { challenge } = await adminGetChallenge(walletAddress);

      // 2. Build a zero-amount self-payment with the nonce in the note field.
      const algod = new algosdk.Algodv2("", ALGOD_BASE_URL, "");
      const params = await algod.getTransactionParams().do();
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: walletAddress,
        receiver: walletAddress,
        amount: 0,
        note: new TextEncoder().encode(`lootbox-admin-auth:${challenge}`),
        suggestedParams: params,
      });

      // 3. Sign with the connected wallet (the tx is never submitted on-chain).
      const encodedTxn = algosdk.encodeUnsignedTransaction(txn);
      const signedTxns = await signTransactions([encodedTxn]);
      const signed = signedTxns[0];
      if (!signed) throw new Error("Transaction was not signed");
      const signedBase64 = Buffer.from(signed).toString("base64");

      // 4. Send the signed tx to the server to create a session.
      await adminCreateSession(walletAddress, signedBase64);
      setAuthenticated(true);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Authentication failed.";
      setAuthError(message);
    } finally {
      setAuthLoading(false);
    }
  }, [walletAddress, signTransactions]);

  // Auto-authenticate on mount if wallet is connected.
  useEffect(() => {
    if (walletAddress && !authenticated && !authLoading) {
      authenticate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // ---------------------------------------------------------------------------
  // Load data once authenticated
  // ---------------------------------------------------------------------------
  const loadPrizes = useCallback(async () => {
    if (!walletAddress) return;
    try {
      const { prizes: loaded } = await adminGetPrizes(walletAddress);
      setPrizes(loaded);
    } catch {
      setStatusMsg("Failed to load prizes.");
    }
  }, [walletAddress]);

  const loadRevenue = useCallback(async () => {
    if (!walletAddress) return;
    try {
      const data = await adminGetRevenue(walletAddress);
      setRevenue(data);
    } catch {
      // Silently fail for auto-refresh.
    }
  }, [walletAddress]);

  const loadNfts = useCallback(async () => {
    if (!walletAddress) return;
    try {
      const { nfts: loaded } = await adminGetBuyerNfts(walletAddress);
      setNfts(loaded);
    } catch {
      // Silently fail.
    }
  }, [walletAddress]);

  useEffect(() => {
    if (authenticated && walletAddress) {
      loadPrizes();
      loadRevenue();
      loadNfts();

      // Auto-refresh revenue and NFT inventory every 30 seconds.
      revenueIntervalRef.current = setInterval(() => {
        loadRevenue();
        loadNfts();
      }, 30_000);
    }

    return () => {
      if (revenueIntervalRef.current) {
        clearInterval(revenueIntervalRef.current);
      }
    };
  }, [authenticated, walletAddress, loadPrizes, loadRevenue, loadNfts]);

  // ---------------------------------------------------------------------------
  // Prize CRUD helpers
  // ---------------------------------------------------------------------------
  const totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);

  function probability(weight: number): string {
    if (totalWeight === 0) return "0";
    return ((weight / totalWeight) * 100).toFixed(2);
  }

  function startEdit(index: number) {
    setEditingIndex(index);
    setEditForm({ ...prizes[index] });
  }

  function cancelEdit() {
    setEditingIndex(null);
    setEditForm(EMPTY_PRIZE);
  }

  function applyEdit() {
    if (editingIndex === null) return;
    const updated = [...prizes];
    updated[editingIndex] = {
      ...editForm,
      color: RARITY_COLORS[editForm.rarity] || editForm.color,
    };
    setPrizes(updated);
    cancelEdit();
  }

  function addPrize() {
    const newPrize: PrizeTier = {
      ...EMPTY_PRIZE,
      id: `prize-${Date.now()}`,
      name: "New Prize",
    };
    setPrizes([...prizes, newPrize]);
  }

  function removePrize(index: number) {
    const prizeName = prizes[index]?.name || "this prize";
    if (!confirm(`Remove "${prizeName}" from the prize table?`)) return;
    setPrizes(prizes.filter((_, i) => i !== index));
    if (editingIndex === index) cancelEdit();
  }

  function duplicatePrize(index: number) {
    const clone: PrizeTier = {
      ...prizes[index],
      id: `${prizes[index].id}-copy-${Date.now()}`,
      name: `${prizes[index].name} (copy)`,
    };
    const updated = [...prizes];
    updated.splice(index + 1, 0, clone);
    setPrizes(updated);
  }

  function movePrize(index: number, direction: "up" | "down") {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= prizes.length) return;
    const updated = [...prizes];
    [updated[index], updated[target]] = [updated[target], updated[index]];
    setPrizes(updated);
  }

  // ---------------------------------------------------------------------------
  // Save prizes
  // ---------------------------------------------------------------------------
  async function handleSave() {
    if (!walletAddress) return;
    setSaving(true);
    setStatusMsg(null);
    try {
      const { count } = await adminSavePrizes(walletAddress, prizes);
      setStatusMsg(`Saved ${count} prizes successfully.`);
    } catch {
      setStatusMsg("Failed to save prizes.");
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Opt-in
  // ---------------------------------------------------------------------------
  async function handleOptIn() {
    if (!walletAddress || !optInAssetId) return;
    setOptInLoading(true);
    setOptInMessage(null);
    try {
      const { message } = await adminOptIn(
        walletAddress,
        parseInt(optInAssetId, 10)
      );
      setOptInMessage(message);
      setOptInAssetId("");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Opt-in failed.";
      setOptInMessage(message);
    } finally {
      setOptInLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Format helpers
  // ---------------------------------------------------------------------------
  function formatAlgo(microAlgos: number): string {
    const algos = microAlgos / 1_000_000;
    return algos % 1 === 0
      ? algos.toFixed(0)
      : algos.toFixed(6).replace(/0+$/, "");
  }

  // ---------------------------------------------------------------------------
  // Render: Not authenticated
  // ---------------------------------------------------------------------------
  if (!authenticated) {
    return (
      <div className="mx-auto max-w-xl py-20 text-center">
        <h1 className="text-2xl font-bold text-zinc-100">
          Loot Box Admin
        </h1>
        <p className="mt-3 text-sm text-zinc-400">
          Sign a message with your admin wallet to continue.
        </p>
        {authError && (
          <p className="mt-4 text-sm text-red-400">{authError}</p>
        )}
        <button
          onClick={authenticate}
          disabled={authLoading}
          className="mt-6 rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {authLoading ? "Authenticating..." : "Authenticate"}
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Authenticated admin panel
  // ---------------------------------------------------------------------------
  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-10">
      <h1 className="text-2xl font-bold text-zinc-100">
        Loot Box Admin
      </h1>

      {/* ----------------------------------------------------------------- */}
      {/* Revenue Dashboard                                                  */}
      {/* ----------------------------------------------------------------- */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
        <h2 className="text-lg font-semibold text-zinc-100">Revenue</h2>
        {revenue ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs uppercase tracking-wide text-zinc-500">
                Crate Price
              </p>
              <p className="mt-1 text-xl font-bold text-zinc-100">
                {revenue.cratePrice} ALGO
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs uppercase tracking-wide text-zinc-500">
                Treasury Balance
              </p>
              <p className="mt-1 text-xl font-bold text-zinc-100">
                {formatAlgo(revenue.treasuryBalanceMicroAlgo)} ALGO
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-xs uppercase tracking-wide text-zinc-500">
                Master Wallet Balance
              </p>
              <p className="mt-1 text-xl font-bold text-zinc-100">
                {formatAlgo(revenue.masterWalletBalanceMicroAlgo)} ALGO
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">Loading revenue data...</p>
        )}
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Master Wallet Opt-In                                               */}
      {/* ----------------------------------------------------------------- */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
        <h2 className="text-lg font-semibold text-zinc-100">
          Master Wallet Opt-In
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          Opt the master wallet into a new ASA so it can hold and distribute
          that asset as a prize.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <input
            type="text"
            placeholder="Asset ID"
            value={optInAssetId}
            onChange={(e) => setOptInAssetId(e.target.value)}
            className="w-40 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
          />
          <button
            onClick={handleOptIn}
            disabled={optInLoading || !optInAssetId}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {optInLoading ? "Opting in..." : "Opt In"}
          </button>
        </div>
        {optInMessage && (
          <p className="mt-3 text-sm text-zinc-300">{optInMessage}</p>
        )}
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Prize Configuration                                                */}
      {/* ----------------------------------------------------------------- */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-100">
            Prize Configuration
          </h2>
          <div className="flex items-center gap-3">
            <button
              onClick={addPrize}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              + Add Prize
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : "Save All"}
            </button>
          </div>
        </div>

        {statusMsg && (
          <p className="mt-3 text-sm text-zinc-300">{statusMsg}</p>
        )}

        {/* Prize table */}
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Asset ID</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Weight</th>
                <th className="px-3 py-2">Prob %</th>
                <th className="px-3 py-2">Rarity</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {prizes.map((prize, i) => (
                <tr
                  key={prize.id || i}
                  className="border-b border-zinc-800/50 hover:bg-zinc-800/30"
                >
                  <td className="px-3 py-2 text-zinc-500">{i + 1}</td>
                  <td className="px-3 py-2 text-zinc-100">{prize.name}</td>
                  <td className="px-3 py-2 text-zinc-300">{prize.type}</td>
                  <td className="px-3 py-2 font-mono text-zinc-400">
                    {prize.assetId}
                  </td>
                  <td className="px-3 py-2 text-zinc-300">
                    {prize.amount.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-zinc-300">{prize.weight}</td>
                  <td className="px-3 py-2 text-zinc-300">
                    {probability(prize.weight)}%
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className="inline-block rounded-full px-2 py-0.5 text-xs font-medium"
                      style={{
                        color: RARITY_COLORS[prize.rarity] || "#9ca3af",
                        backgroundColor: `${RARITY_COLORS[prize.rarity] || "#9ca3af"}20`,
                      }}
                    >
                      {prize.rarity}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => startEdit(i)}
                        className="rounded px-1.5 py-0.5 text-xs text-indigo-400 hover:bg-indigo-500/10"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => duplicatePrize(i)}
                        className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700"
                      >
                        Dup
                      </button>
                      <button
                        onClick={() => movePrize(i, "up")}
                        disabled={i === 0}
                        className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 disabled:opacity-30"
                      >
                        Up
                      </button>
                      <button
                        onClick={() => movePrize(i, "down")}
                        disabled={i === prizes.length - 1}
                        className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 disabled:opacity-30"
                      >
                        Dn
                      </button>
                      <button
                        onClick={() => removePrize(i)}
                        className="rounded px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-500/10"
                      >
                        Del
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {prizes.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-6 text-center text-sm text-zinc-500"
                  >
                    No prizes configured. Click &quot;+ Add Prize&quot; to
                    start.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Edit Prize Modal                                                   */}
      {/* ----------------------------------------------------------------- */}
      {editingIndex !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-zinc-100">
              Edit Prize
            </h3>

            <div className="mt-4 space-y-3">
              {/* Name */}
              <div>
                <label className="mb-1 block text-xs text-zinc-500">
                  Name
                </label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={(e) =>
                    setEditForm({ ...editForm, name: e.target.value })
                  }
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              {/* Type */}
              <div>
                <label className="mb-1 block text-xs text-zinc-500">
                  Type
                </label>
                <select
                  value={editForm.type}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      type: e.target.value as "token" | "nft",
                    })
                  }
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="token">Token</option>
                  <option value="nft">NFT</option>
                </select>
              </div>

              {/* Asset ID */}
              <div>
                <label className="mb-1 block text-xs text-zinc-500">
                  Asset ID (ASA)
                </label>
                <input
                  type="number"
                  value={editForm.assetId}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      assetId: parseInt(e.target.value, 10) || 0,
                    })
                  }
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              {/* Amount */}
              <div>
                <label className="mb-1 block text-xs text-zinc-500">
                  Amount
                </label>
                <input
                  type="number"
                  value={editForm.amount}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      amount: parseInt(e.target.value, 10) || 0,
                    })
                  }
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              {/* Weight */}
              <div>
                <label className="mb-1 block text-xs text-zinc-500">
                  Weight (higher = more common)
                </label>
                <input
                  type="number"
                  value={editForm.weight}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      weight: parseInt(e.target.value, 10) || 1,
                    })
                  }
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              {/* Rarity */}
              <div>
                <label className="mb-1 block text-xs text-zinc-500">
                  Rarity
                </label>
                <select
                  value={editForm.rarity}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      rarity: e.target.value as PrizeRarity,
                    })
                  }
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                >
                  {RARITY_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {r.charAt(0).toUpperCase() + r.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Modal actions */}
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={cancelEdit}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={applyEdit}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* NFT Inventory (master wallet assets)                               */}
      {/* ----------------------------------------------------------------- */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
        <h2 className="text-lg font-semibold text-zinc-100">
          Master Wallet Assets
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          Assets currently held by the master wallet (prize pool inventory).
        </p>
        {nfts.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-3 py-2">Asset ID</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Balance</th>
                </tr>
              </thead>
              <tbody>
                {nfts.map((nft) => (
                  <tr
                    key={nft.assetId}
                    className="border-b border-zinc-800/50 hover:bg-zinc-800/30"
                  >
                    <td className="px-3 py-2 font-mono text-zinc-300">
                      {nft.assetId}
                    </td>
                    <td className="px-3 py-2 text-zinc-300">
                      {nft.name || "—"}
                    </td>
                    <td className="px-3 py-2 text-zinc-300">
                      {nft.amount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">
            No assets found in the master wallet.
          </p>
        )}
      </section>
    </div>
  );
}
