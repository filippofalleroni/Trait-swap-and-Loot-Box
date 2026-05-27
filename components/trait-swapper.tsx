"use client";

import React, { useEffect, useMemo, useState } from "react";
import algosdk from "algosdk";
import { useWallet } from "@/contexts/wallet-context";
import { useToast } from "@/contexts/toast-context";
import { feeConfig } from "@/config/fees";
import { ALGOD_BASE_URL } from "@/lib/algorand";
import { mockTraits, mockOwnedNfts } from "@/config/mock-data";
import { LAYER_ORDER, isOfficialTraitCategory } from "@/lib/nft-layering";
import type {
  CollectionNft,
  OfficialTraitCategory,
  Trait,
  TraitRarity,
} from "@/lib/types";
import NftLayeredImage from "@/components/nft-layered-image";

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const RARITY_COLORS: Record<TraitRarity, string> = {
  Common: "text-zinc-400 border-zinc-600",
  Rare: "text-blue-400 border-blue-500",
  Epic: "text-purple-400 border-purple-500",
  Legendary: "text-amber-400 border-amber-500",
};

const RARITY_BG: Record<TraitRarity, string> = {
  Common: "bg-zinc-800/50",
  Rare: "bg-blue-950/40",
  Epic: "bg-purple-950/40",
  Legendary: "bg-amber-950/40",
};

type MintStep = "idle" | "signing" | "submitting" | "minting" | "success" | "error";

/**
 * Categories where the user can choose to remove a trait entirely.
 * BACKGROUND and SKIN are always required, so they are excluded.
 */
const REMOVABLE_CATEGORIES: OfficialTraitCategory[] = [
  "BODY",
  "COMPANION",
  "EYES",
  "MOUTH",
  "TOP",
];

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function TraitSwapper() {
  const { walletAddress, signTransactions, isConnected } = useWallet();
  const { pushToast } = useToast();

  // ---- NFTs state ----
  const [ownedNfts, setOwnedNfts] = useState<CollectionNft[]>([]);
  const [selectedNft, setSelectedNft] = useState<CollectionNft | null>(null);
  const [loadingNfts, setLoadingNfts] = useState(false);
  const [hasFetchedNfts, setHasFetchedNfts] = useState(false);
  /**
   * Set this to a message string if NFT loading fails and you want to show
   * a dedicated error screen instead of falling back to mock data.
   * By default the template uses mock data on failure, so this stays null.
   */
  const [nftLoadError, setNftLoadError] = useState<string | null>(null);

  // ---- Trait browsing state ----
  const [activeCategory, setActiveCategory] = useState<OfficialTraitCategory>("BACKGROUND");
  const [selectedTrait, setSelectedTrait] = useState<Trait | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  // ---- Trait detail modal ----
  const [detailTrait, setDetailTrait] = useState<Trait | null>(null);

  // ---- Mint flow state ----
  const [mintStep, setMintStep] = useState<MintStep>("idle");
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [mintResult, setMintResult] = useState<string | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);

  // ---- Trait counts (how many times each trait has been applied) ----
  const [traitCounts, setTraitCounts] = useState<Record<string, number>>({});

  // ---- Pending payment TX (stored in sessionStorage for crash recovery) ----
  const [pendingPaymentTxId, setPendingPaymentTxId] = useState<string | null>(function initPending() {
    if (typeof window === "undefined") return null;
    try {
      return sessionStorage.getItem("traitswap_pending_tx") || null;
    } catch { return null; }
  });

  /* ---------------------------------------------------------------- */
  /*  Load owned NFTs                                                 */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!isConnected || !walletAddress) return;

    let isCancelled = false;

    // Delay showing the loading spinner by 300ms to avoid a flash for fast loads
    const loadingTimer = setTimeout(function showLoading() {
      if (!isCancelled) setLoadingNfts(true);
    }, 300);

    setNftLoadError(null);

    async function doLoad() {
      try {
        const res = await fetch(
          "/api/owned-nfts?wallet=" + encodeURIComponent(walletAddress!),
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error("NFT API failed with status " + res.status);

        const data = await res.json();
        const nfts: CollectionNft[] = data.nfts ?? [];
        if (isCancelled) return;

        // If API returns empty (no collection configured), fall back to mock data
        if (nfts.length === 0) {
          setOwnedNfts(mockOwnedNfts);
          setSelectedNft(mockOwnedNfts[0] ?? null);
        } else {
          setOwnedNfts(nfts);
          setSelectedNft(nfts[0] ?? null);
        }
      } catch (err) {
        if (isCancelled) return;
        console.error("Failed to load owned NFTs", err);
        // Fall back to mock data for demo/development.
        // For production, remove the mock fallback and set the error instead:
        //   setNftLoadError("Could not load NFTs from this wallet.");
        setOwnedNfts(mockOwnedNfts);
        setSelectedNft(mockOwnedNfts[0] ?? null);
      } finally {
        if (!isCancelled) {
          clearTimeout(loadingTimer);
          setLoadingNfts(false);
          setHasFetchedNfts(true);
        }
      }
    }

    void doLoad();

    return function cleanup() {
      isCancelled = true;
      clearTimeout(loadingTimer);
    };
  }, [isConnected, walletAddress]);

  /* ---------------------------------------------------------------- */
  /*  Load trait counts                                               */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    fetch("/api/trait-counts")
      .then((r) => r.json())
      .then((data) => setTraitCounts(data ?? {}))
      .catch(() => {});
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Pending payment TX persistence                                  */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    try {
      if (pendingPaymentTxId) {
        sessionStorage.setItem("traitswap_pending_tx", pendingPaymentTxId);
      } else {
        sessionStorage.removeItem("traitswap_pending_tx");
      }
    } catch { /* sessionStorage unavailable */ }
  }, [pendingPaymentTxId]);

  /* ---------------------------------------------------------------- */
  /*  Derived values                                                  */
  /* ---------------------------------------------------------------- */

  const traitsForCategory = useMemo(
    () => mockTraits.filter((t) => t.category === activeCategory),
    [activeCategory]
  );

  const currentTraitName = useMemo(() => {
    if (!selectedNft?.layers) return null;
    return selectedNft.layers[activeCategory] ?? null;
  }, [selectedNft, activeCategory]);

  // Build layer overrides for preview
  const layerOverrides = useMemo(() => {
    if (!isPreviewing || !selectedTrait) return undefined;
    const cat = selectedTrait.category as OfficialTraitCategory;
    if (!isOfficialTraitCategory(cat)) return undefined;
    return { [cat]: selectedTrait.imageUrl } as Partial<
      Record<OfficialTraitCategory, string | null>
    >;
  }, [isPreviewing, selectedTrait]);

  /* ---------------------------------------------------------------- */
  /*  Trait removal preview                                           */
  /* ---------------------------------------------------------------- */

  const [previewingRemoval, setPreviewingRemoval] = useState(false);

  const removalLayerOverrides = useMemo(() => {
    if (!previewingRemoval) return undefined;
    return { [activeCategory]: null } as Partial<
      Record<OfficialTraitCategory, string | null>
    >;
  }, [previewingRemoval, activeCategory]);

  const effectiveOverrides = previewingRemoval
    ? removalLayerOverrides
    : layerOverrides;

  /** Whether the active category allows trait removal */
  const canRemoveCategory = REMOVABLE_CATEGORIES.indexOf(activeCategory) !== -1;

  /* ---------------------------------------------------------------- */
  /*  Handlers                                                        */
  /* ---------------------------------------------------------------- */

  function handleSelectTrait(trait: Trait) {
    setPreviewingRemoval(false);
    if (selectedTrait?.id === trait.id) {
      setSelectedTrait(null);
      setIsPreviewing(false);
    } else {
      setSelectedTrait(trait);
      setIsPreviewing(false);
    }
  }

  function handlePreview() {
    if (selectedTrait) {
      setIsPreviewing(true);
      setPreviewingRemoval(false);
    }
  }

  function handlePreviewRemoval() {
    setSelectedTrait(null);
    setIsPreviewing(false);
    setPreviewingRemoval(true);
  }

  function handleCancelPreview() {
    setIsPreviewing(false);
    setPreviewingRemoval(false);
  }

  function handleApplyClick() {
    if (!selectedTrait && !previewingRemoval) return;
    setShowConfirmModal(true);
  }

  /* ---------------------------------------------------------------- */
  /*  Mint flow                                                       */
  /* ---------------------------------------------------------------- */

  async function executeMint() {
    if (!walletAddress || !selectedNft) return;

    const traitId = selectedTrait?.id ?? "remove-" + activeCategory;
    const isRemoval = !selectedTrait;

    setShowConfirmModal(false);
    setMintStep("signing");
    setMintError(null);
    setMintResult(null);
    setPendingPaymentTxId(null);

    let paymentConfirmed = false;
    try {
      // Step 1: Get unsigned payment transaction
      const payRes = await fetch("/api/trait-lab/payment-tx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: walletAddress,
          newTraitId: traitId,
        }),
      });

      if (!payRes.ok) {
        const errData = await payRes.json().catch(function () { return {} as Record<string, string>; });
        throw new Error(errData.error ?? "Failed to create payment transaction");
      }

      const payData = await payRes.json();
      const unsignedTxnBase64: string = payData.unsignedTxnBase64;

      // Step 2: Sign with wallet
      const txnBytes = new Uint8Array(Buffer.from(unsignedTxnBase64, "base64"));

      const signedTxns = await signTransactions([txnBytes]);
      const signedTxn = signedTxns[0];
      if (!signedTxn) throw new Error("Transaction was not signed");

      // Step 3: Submit signed transaction to the chain
      setMintStep("submitting");

      const algodClient = new algosdk.Algodv2("", ALGOD_BASE_URL, "");
      const submitResult = await algodClient
        .sendRawTransaction(signedTxn)
        .do();
      const paymentTxId: string = submitResult.txid;
      setPendingPaymentTxId(paymentTxId);
      await algosdk.waitForConfirmation(algodClient, paymentTxId, 10);
      paymentConfirmed = true;

      // Step 4: Trigger the mint / ARC-19 update
      setMintStep("minting");

      const mintRes = await fetch("/api/trait-lab/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nftAssetId: selectedNft.assetId,
          newTraitId: traitId,
          walletAddress: walletAddress,
          paymentTxId: paymentTxId,
        }),
      });

      if (!mintRes.ok) {
        const mintErrData = await mintRes.json().catch(function () { return {} as Record<string, string>; });
        throw new Error(mintErrData.error ?? "Mint failed");
      }

      const result = await mintRes.json();

      // Optimistic update: apply the trait change to the local NFT state immediately
      if (selectedTrait && isOfficialTraitCategory(selectedTrait.category)) {
        const updatedLayers = Object.assign({}, selectedNft.layers);
        const updatedLayerImageUrls = Object.assign({}, selectedNft.layerImageUrls);
        updatedLayers[selectedTrait.category as OfficialTraitCategory] = selectedTrait.name;
        updatedLayerImageUrls[selectedTrait.category as OfficialTraitCategory] = selectedTrait.imageUrl;
        const updatedNft: CollectionNft = Object.assign({}, selectedNft, {
          layers: updatedLayers,
          layerImageUrls: updatedLayerImageUrls,
        });
        setOwnedNfts(function updateList(current) {
          return current.map(function replace(n) { return n.id === selectedNft.id ? updatedNft : n; });
        });
        setSelectedNft(updatedNft);
      } else if (isRemoval && isOfficialTraitCategory(activeCategory)) {
        const removedLayers = Object.assign({}, selectedNft.layers);
        const removedLayerImageUrls = Object.assign({}, selectedNft.layerImageUrls);
        delete removedLayers[activeCategory];
        delete removedLayerImageUrls[activeCategory];
        const removedNft: CollectionNft = Object.assign({}, selectedNft, {
          layers: removedLayers,
          layerImageUrls: removedLayerImageUrls,
        });
        setOwnedNfts(function updateList(current) {
          return current.map(function replace(n) { return n.id === selectedNft.id ? removedNft : n; });
        });
        setSelectedNft(removedNft);
      }

      setMintStep("success");
      setMintResult(result.note ?? (isRemoval ? "Trait removed successfully." : "Trait applied successfully."));
      pushToast(isRemoval ? "Trait removed!" : "Trait applied!");
      setPendingPaymentTxId(null);

      // Refresh trait counts so supply display stays accurate
      fetch("/api/trait-counts")
        .then(function (r) { return r.json(); })
        .then(function (data) { setTraitCounts(data ?? {}); })
        .catch(function () { /* ignore */ });
    } catch (err: unknown) {
      setMintStep("error");
      const message = err instanceof Error ? err.message : "Something went wrong";
      setMintError(message);
      if (!paymentConfirmed) {
        pushToast("Error: " + message);
      }
    }
  }

  function resetMintState() {
    setMintStep("idle");
    setMintResult(null);
    setMintError(null);
    setSelectedTrait(null);
    setIsPreviewing(false);
    setPreviewingRemoval(false);
    setPendingPaymentTxId(null);
  }

  /* ---------------------------------------------------------------- */
  /*  Price display                                                   */
  /* ---------------------------------------------------------------- */

  const displayPrice = selectedTrait
    ? selectedTrait.priceAlgo
    : previewingRemoval
      ? feeConfig.removalFeeAlgo
      : null;

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */

  return (
    <div className="w-full max-w-6xl mx-auto">
      {/* NFT Selector (if multiple NFTs) */}
      {ownedNfts.length > 1 && (
        <div className="mb-6">
          <p className="text-sm text-zinc-400 mb-2">Select NFT</p>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {ownedNfts.map((nft) => (
              <button
                key={nft.id}
                onClick={() => {
                  setSelectedNft(nft);
                  setSelectedTrait(null);
                  setIsPreviewing(false);
                  setPreviewingRemoval(false);
                }}
                className={`flex-shrink-0 rounded-lg border-2 p-1 transition-all ${
                  selectedNft?.id === nft.id
                    ? "border-emerald-500 shadow-lg shadow-emerald-500/20"
                    : "border-zinc-700 hover:border-zinc-500"
                }`}
              >
                <div className="w-16 h-16 rounded-md overflow-hidden bg-zinc-800">
                  {nft.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={nft.imageUrl}
                      alt={nft.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-600 text-xs">
                      NFT
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Loading state */}
      {loadingNfts && (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-500" />
            <p className="text-sm text-zinc-400">Loading your NFTs...</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {!loadingNfts && nftLoadError && ownedNfts.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-12 text-center">
          <h3 className="text-lg font-semibold text-zinc-200">NFT Load Failed</h3>
          <p className="text-sm text-zinc-400 max-w-md">{nftLoadError}</p>
        </div>
      )}

      {/* Empty state */}
      {!loadingNfts && !nftLoadError && hasFetchedNfts && ownedNfts.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-12 text-center">
          <h3 className="text-lg font-semibold text-zinc-200">No NFTs Found</h3>
          <p className="text-sm text-zinc-400 max-w-md">
            We couldn&apos;t find any collection NFTs in your wallet. Make sure
            you&apos;re connected with the right wallet and own at least one NFT
            from this collection.
          </p>
        </div>
      )}

      {/* Main two-panel layout */}
      {!loadingNfts && selectedNft && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ========== LEFT PANEL: NFT Preview ========== */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-zinc-100">
                    {selectedNft.name}
                  </h3>
                  {selectedNft.unitName && (
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {selectedNft.unitName}
                      {selectedNft.assetId ? ` · ASA ${selectedNft.assetId}` : ""}
                    </p>
                  )}
                </div>
                {(isPreviewing || previewingRemoval) && (
                  <span className="rounded-full bg-emerald-900/40 border border-emerald-700/50 px-3 py-1 text-xs font-medium text-emerald-400">
                    Preview
                  </span>
                )}
              </div>

              {/* NFT Image */}
              <div className="flex justify-center">
                <NftLayeredImage
                  nft={selectedNft}
                  layerOverrides={effectiveOverrides}
                  size={360}
                  className="shadow-2xl shadow-black/50"
                />
              </div>

              {/* Current vs New trait info */}
              {(selectedTrait || previewingRemoval) && (
                <div className="mt-4 rounded-lg bg-zinc-800/50 p-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1">
                        Current
                      </p>
                      <p className="text-sm text-zinc-300">
                        {currentTraitName ?? (
                          <span className="text-zinc-600 italic">None</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1">
                        New
                      </p>
                      <p className="text-sm text-zinc-100 font-medium">
                        {previewingRemoval ? (
                          <span className="text-red-400">Remove</span>
                        ) : (
                          selectedTrait?.name ?? "--"
                        )}
                      </p>
                    </div>
                  </div>

                  {displayPrice !== null && (
                    <div className="mt-3 pt-3 border-t border-zinc-700/50 flex items-center justify-between">
                      <span className="text-xs text-zinc-500">Cost</span>
                      <span className="text-sm font-semibold text-emerald-400">
                        {displayPrice} ALGO
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex gap-3">
              {(isPreviewing || previewingRemoval) && (
                <button
                  onClick={handleCancelPreview}
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors"
                >
                  Cancel Preview
                </button>
              )}

              {selectedTrait && !isPreviewing && (
                <button
                  onClick={handlePreview}
                  className="flex-1 rounded-lg border border-emerald-700/50 bg-emerald-900/30 px-4 py-2.5 text-sm font-medium text-emerald-400 hover:bg-emerald-900/50 transition-colors"
                >
                  Preview Change
                </button>
              )}

              {(isPreviewing || previewingRemoval) && (
                <button
                  onClick={handleApplyClick}
                  disabled={mintStep !== "idle"}
                  className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {previewingRemoval ? "Remove Trait" : "Apply Trait"}
                </button>
              )}
            </div>
          </div>

          {/* ========== RIGHT PANEL: Trait Browser ========== */}
          <div className="flex flex-col gap-4">
            {/* Category pills */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">
                Category
              </p>
              <div className="flex flex-wrap gap-2">
                {LAYER_ORDER.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => {
                      setActiveCategory(cat);
                      setSelectedTrait(null);
                      setIsPreviewing(false);
                      setPreviewingRemoval(false);
                    }}
                    className={`rounded-full px-4 py-1.5 text-xs font-medium transition-all ${
                      activeCategory === cat
                        ? "bg-emerald-600 text-white shadow-md shadow-emerald-600/20"
                        : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Remove trait option (only for categories that allow removal) */}
            {currentTraitName && canRemoveCategory && (
              <button
                onClick={handlePreviewRemoval}
                className={`w-full rounded-lg border px-4 py-3 text-sm text-left transition-all ${
                  previewingRemoval
                    ? "border-red-500/50 bg-red-950/30 text-red-400"
                    : "border-zinc-700/50 bg-zinc-900/40 text-zinc-400 hover:border-red-700/40 hover:text-red-400"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-base">&#x2716;</span>
                    <span>Remove {activeCategory.toLowerCase()} trait</span>
                  </div>
                  <span className="text-xs text-zinc-500">
                    {feeConfig.removalFeeAlgo} ALGO
                  </span>
                </div>
              </button>
            )}

            {/* Trait grid */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                  Available Traits
                </p>
                <p className="text-xs text-zinc-600">
                  {traitsForCategory.length} trait{traitsForCategory.length !== 1 ? "s" : ""}
                </p>
              </div>

              {traitsForCategory.length === 0 ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-zinc-500">
                    No traits available for this category.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {traitsForCategory.map((trait) => {
                    const isSelected = selectedTrait?.id === trait.id;
                    const isCurrent = currentTraitName === trait.name;
                    const mintCount = traitCounts[trait.id] ?? 0;

                    return (
                      <button
                        key={trait.id}
                        onClick={() => handleSelectTrait(trait)}
                        disabled={isCurrent}
                        className={`group relative rounded-lg border p-3 text-left transition-all ${
                          isSelected
                            ? "border-emerald-500 bg-emerald-950/30 shadow-md shadow-emerald-500/10"
                            : isCurrent
                              ? "border-zinc-700/50 bg-zinc-800/30 opacity-50 cursor-not-allowed"
                              : "border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600 hover:bg-zinc-800/60"
                        }`}
                      >
                        {/* Trait image */}
                        <div className="relative aspect-square rounded-md overflow-hidden bg-zinc-900 mb-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={trait.imageUrl}
                            alt={trait.name}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = "none";
                            }}
                          />
                          {/* Rarity badge */}
                          <span
                            className={`absolute top-1 right-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium border ${RARITY_COLORS[trait.rarity]} ${RARITY_BG[trait.rarity]}`}
                          >
                            {trait.rarity}
                          </span>

                          {isCurrent && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                              <span className="rounded-full bg-zinc-900/90 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
                                Equipped
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Info */}
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium text-zinc-200 truncate flex-1">
                            {trait.name}
                          </p>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDetailTrait(trait);
                            }}
                            className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300 transition-colors"
                            aria-label={`View details for ${trait.name}`}
                          >
                            i
                          </button>
                        </div>
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-xs font-semibold text-emerald-400">
                            {trait.priceAlgo} ALGO
                          </span>
                          {mintCount > 0 && (
                            <span className="text-[10px] text-zinc-600">
                              {mintCount} applied
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========== Trait Detail Modal ========== */}
      {detailTrait && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-emerald-400">
                  Trait Preview
                </p>
                <h3 className="mt-1 text-xl font-semibold text-zinc-100">
                  {detailTrait.name}
                </h3>
              </div>
              <button
                onClick={() => setDetailTrait(null)}
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
                aria-label="Close"
              >
                &#x2715;
              </button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={detailTrait.imageUrl}
                alt={detailTrait.name}
                className="w-full rounded-xl border border-zinc-800 object-cover aspect-square bg-zinc-950"
              />
              <div className="space-y-4">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
                  <p className="text-[10px] uppercase tracking-widest text-zinc-500">
                    Category
                  </p>
                  <p className="mt-1 text-sm text-zinc-200">
                    {detailTrait.category}
                  </p>
                  <p className="mt-3 text-[10px] uppercase tracking-widest text-zinc-500">
                    Rarity
                  </p>
                  <p className="mt-1 text-sm">
                    <span className={RARITY_COLORS[detailTrait.rarity]}>
                      {detailTrait.rarity}
                    </span>
                  </p>
                  {detailTrait.description && (
                    <>
                      <p className="mt-3 text-[10px] uppercase tracking-widest text-zinc-500">
                        Description
                      </p>
                      <p className="mt-1 text-sm text-zinc-300">
                        {detailTrait.description}
                      </p>
                    </>
                  )}
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-400">Price</span>
                    <span className="text-lg font-semibold text-emerald-400">
                      {detailTrait.priceAlgo} ALGO
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-zinc-600">+ network fee</span>
                    <span className="text-xs text-zinc-600">
                      ~{feeConfig.estimatedTxFeeAlgo} ALGO
                    </span>
                  </div>
                </div>

                <button
                  onClick={() => {
                    handleSelectTrait(detailTrait);
                    setDetailTrait(null);
                  }}
                  disabled={currentTraitName === detailTrait.name}
                  className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {currentTraitName === detailTrait.name
                    ? "Currently Equipped"
                    : "Select Trait"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== Confirmation Modal ========== */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-zinc-100 mb-2">
              Confirm {previewingRemoval ? "Removal" : "Trait Swap"}
            </h3>
            <p className="text-sm text-zinc-400 mb-4">
              {previewingRemoval
                ? `Remove the ${activeCategory.toLowerCase()} trait from ${selectedNft?.name}?`
                : `Apply "${selectedTrait?.name}" to ${selectedNft?.name}?`}
            </p>

            <div className="rounded-lg bg-zinc-800/60 p-4 mb-5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-zinc-400">Cost</span>
                <span className="text-lg font-semibold text-emerald-400">
                  {displayPrice} ALGO
                </span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-xs text-zinc-600">+ network fee</span>
                <span className="text-xs text-zinc-600">
                  ~{feeConfig.estimatedTxFeeAlgo} ALGO
                </span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeMint}
                className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 transition-colors"
              >
                Confirm &amp; Sign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== Mint Progress / Result Overlay ========== */}
      {mintStep !== "idle" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl text-center">
            {/* Signing */}
            {mintStep === "signing" && (
              <>
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-500 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-zinc-100 mb-1">
                  Sign Transaction
                </h3>
                <p className="text-sm text-zinc-400">
                  Please approve the transaction in your wallet.
                </p>
              </>
            )}

            {/* Submitting */}
            {mintStep === "submitting" && (
              <>
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-500 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-zinc-100 mb-1">
                  Submitting Payment
                </h3>
                <p className="text-sm text-zinc-400">
                  Broadcasting your transaction to the network...
                </p>
              </>
            )}

            {/* Minting */}
            {mintStep === "minting" && (
              <>
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-500 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-zinc-100 mb-1">
                  Applying Trait
                </h3>
                <p className="text-sm text-zinc-400">
                  Updating your NFT metadata...
                </p>
              </>
            )}

            {/* Success */}
            {mintStep === "success" && (
              <>
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-900/50 border border-emerald-700/50">
                  <svg
                    className="h-6 w-6 text-emerald-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-zinc-100 mb-1">
                  Success!
                </h3>
                <p className="text-sm text-zinc-400 mb-5">{mintResult}</p>
                <button
                  onClick={resetMintState}
                  className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 transition-colors"
                >
                  Done
                </button>
              </>
            )}

            {/* Error */}
            {mintStep === "error" && (
              <>
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-900/50 border border-red-700/50">
                  <svg
                    className="h-6 w-6 text-red-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-zinc-100 mb-1">
                  Error
                </h3>
                <p className="text-sm text-red-400 mb-3">{mintError}</p>

                {/* Warn if payment was confirmed but mint failed */}
                {pendingPaymentTxId && (
                  <div className="rounded-lg border border-yellow-600/40 bg-yellow-900/20 px-4 py-3 mb-4 text-left">
                    <p className="text-sm font-semibold text-yellow-300">
                      Payment was confirmed on-chain
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-yellow-200/80">
                      Your payment went through but we lost the response &mdash; possibly
                      due to a network interruption. Your NFT may already be updated.
                      Please check before retrying.
                    </p>
                    {selectedNft?.assetId && (
                      <a
                        href={"https://allo.info/asset/" + selectedNft.assetId + "/nft"}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block text-xs font-medium text-yellow-300 hover:text-yellow-100 transition-colors"
                      >
                        Check NFT on Allo.info &rarr;
                      </a>
                    )}
                  </div>
                )}

                <button
                  onClick={resetMintState}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-6 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors"
                >
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
