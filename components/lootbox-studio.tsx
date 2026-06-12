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

// Block-seed mode:  idle → committing → signing(payment) → distributing → success
// Beacon mode:      idle → committing → signing(payment) → waiting-vrf →
//                   revealing(sign) → distributing → success
// Either mode adds one extra signing(optin) step if the won asset isn't held.
type LootboxState =
  | "idle"
  | "committing"
  | "signing"
  | "waiting-vrf"
  | "revealing"
  | "distributing"
  | "success"
  | "error";

// What the current wallet prompt is for, so the modal can label it clearly.
type SignContext = "payment" | "optin";

type RandomnessMode = "block-seed" | "beacon";

interface PrizeSummary {
  id: string;
  name: string;
  type: string;
  rarity: PrizeRarity;
  color: string;
}

interface RevealResult {
  prize: PrizeSummary;
  paymentTxId: string;
  distributionTxId: string;
  status: string;
}

interface PendingReveal {
  walletAddress: string;
  paymentTxId: string;
  mode: RandomnessMode;
  commitRound: number;
  revealTxId?: string;
}

const PENDING_KEY = "lootbox_pending_reveal";
const MIN_WAIT_ROUNDS = 9;

// Light flavour text shown while the prize is being drawn + delivered — the
// wait the user actually stares at. One is picked per open for variety.
const WAIT_QUIPS = [
  "Shaking the loot box as hard as we can…",
  "The dice are tumbling across the blockchain…",
  "Drawing your prize from freshly minted block seeds…",
  "Consulting the chain's crystal ball…",
  "Sorting the loot… nearly there…",
];

/* ------------------------------------------------------------------ */
/*  Error humanizing                                                  */
/* ------------------------------------------------------------------ */

// Map raw wallet/node errors to plain language. Anything that looks like a raw
// chain/SDK error is never shown to a player; the original is logged instead.
function humanizeError(raw: string): string {
  const m = raw.toLowerCase();
  if (
    m.includes("overspend") ||
    m.includes("tried to spend") ||
    m.includes("insufficient") ||
    (m.includes("balance") && m.includes("below"))
  ) {
    return "You don't have enough ALGO in your wallet to open a loot box.";
  }
  if (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("network request") ||
    m.includes("err_internet")
  ) {
    return "Connection issue — please check your internet and try again.";
  }
  if (
    m.includes("logic eval") ||
    m.includes("transactionpool") ||
    m.includes("opcodes") ||
    m.includes("pc=") ||
    raw.length > 200
  ) {
    return "Something went wrong opening your loot box. Please try again.";
  }
  return raw;
}

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

const RARITY_EMOJI: Record<PrizeRarity, string> = {
  common: "\u{1F381}",
  uncommon: "\u{1F381}",
  rare: "\u{1F48E}",
  epic: "✨",
  legendary: "⭐",
};

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function LootboxStudio() {
  const { walletAddress, signTransactions, disconnectWallet } = useWallet();

  const [state, setState] = useState<LootboxState>("idle");
  const [signContext, setSignContext] = useState<SignContext>("payment");
  const [prizes, setPrizes] = useState<PrizeTier[]>([]);
  const [prizesLoaded, setPrizesLoaded] = useState(false);
  const [result, setResult] = useState<RevealResult | null>(null);
  // The won-but-not-yet-delivered prize (the opt-in step), shown on screen so
  // the "approve to receive" signature is never a blind sign.
  const [pendingPrize, setPendingPrize] = useState<PrizeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [walletResetNeeded, setWalletResetNeeded] = useState(false);
  const [showPrizes, setShowPrizes] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [playAgainFlag, setPlayAgainFlag] = useState(false);
  const [buyerBalance, setBuyerBalance] = useState<number | null>(null);
  const [vrfProgress, setVrfProgress] = useState("");
  const [quip, setQuip] = useState(WAIT_QUIPS[0]);
  // Reentrancy guard: a money flow must never double-fire and submit twice.
  const processingRef = useRef(false);
  // Identifies the current open attempt. Cancelling (or starting a new attempt)
  // bumps this so a wallet signature that resolves AFTER the user backed out is
  // ignored instead of silently submitting a payment.
  const attemptRef = useRef(0);
  const [pendingReveal, setPendingReveal] = useState<PendingReveal | null>(
    () => {
      if (typeof window === "undefined") return null;
      try {
        const stored = localStorage.getItem(PENDING_KEY);
        if (!stored) return null;
        const parsed = JSON.parse(stored) as Partial<PendingReveal>;
        // Drop records from incompatible versions of this component.
        if (parsed.mode !== "block-seed" && parsed.mode !== "beacon") return null;
        return parsed as PendingReveal;
      } catch {
        return null;
      }
    }
  );

  /* ---------------------------------------------------------------- */
  /*  Sync pendingReveal to localStorage                              */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    try {
      if (pendingReveal) {
        localStorage.setItem(PENDING_KEY, JSON.stringify(pendingReveal));
      } else {
        localStorage.removeItem(PENDING_KEY);
      }
    } catch {
      // localStorage not available
    }
  }, [pendingReveal]);

  /* ---------------------------------------------------------------- */
  /*  Load prizes                                                     */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    fetch("/api/lootbox/prizes")
      .then(function (r) { if (!r.ok) throw new Error("fetch failed"); return r.json(); })
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
  /*  Beacon mode: wait for the target VRF round                      */
  /* ---------------------------------------------------------------- */

  async function waitForVrfRounds(
    algodClient: algosdk.Algodv2,
    commitRound: number
  ): Promise<void> {
    const targetRound = commitRound + MIN_WAIT_ROUNDS;
    for (let i = 0; i < 30; i++) {
      const status = (await algodClient.status().do()) as unknown as Record<string, unknown>;
      // algosdk v3 returns camelCase (lastRound); keep the kebab fallback for
      // older SDK responses.
      const currentRound = Number(status["lastRound"] ?? status["last-round"] ?? 0);
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
  /*  Beacon mode: build, sign, and submit the on-chain reveal        */
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
    if (!signedArr[0]) {
      throw new Error("Wallet declined to sign the reveal transaction.");
    }

    const { txid } = await algodClient.sendRawTransaction([signedArr[0]]).do();
    await algosdk.waitForConfirmation(algodClient, txid as string, 10);

    return txid as string;
  }

  /* ---------------------------------------------------------------- */
  /*  Opt into a single won asset (free, zero-amount self-transfer)   */
  /* ---------------------------------------------------------------- */

  const ensureOptedIn = useCallback(
    async (address: string, assetId: number) => {
      const algodClient = new algosdk.Algodv2("", ALGOD_BASE_URL, "");
      const suggestedParams = await algodClient.getTransactionParams().do();
      const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: address,
        receiver: address,
        assetIndex: assetId,
        amount: 0,
        suggestedParams,
      });
      const signed = await signTransactions!([
        algosdk.encodeUnsignedTransaction(optInTxn),
      ]);
      if (!signed[0]) {
        throw new Error("Wallet declined to sign the opt-in transaction.");
      }
      const { txid } = await algodClient.sendRawTransaction([signed[0]]).do();
      await algosdk.waitForConfirmation(algodClient, txid as string, 4);
    },
    [signTransactions]
  );

  /* ---------------------------------------------------------------- */
  /*  Server reveal call (rolls + distributes the prize)              */
  /* ---------------------------------------------------------------- */

  const callServerReveal = useCallback(
    async (
      address: string,
      paymentTxId: string,
      revealTxId?: string,
      optInAttempted = false
    ): Promise<void> => {
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
          throw new Error("This loot box was already claimed. Check your wallet for the prize.");
        }
        const errObj = errData as Record<string, unknown>;
        const serverError = (errObj.error as string) || `Reveal failed (${res.status})`;
        // If the server says the transaction is too old, the open is
        // irrecoverable — clear pendingReveal so the green "your payment
        // went through" reassurance box doesn't mislead the user.
        if (serverError.toLowerCase().includes("too old")) {
          setPendingReveal(null);
        }
        // If distribution failed, the server includes the prize info so
        // the user (and support) knows what was won.
        const prize = errObj.prize as Record<string, string> | undefined;
        if (prize?.name) {
          throw new Error(`${serverError} (Prize: ${prize.name})`);
        }
        throw new Error(serverError);
      }

      const data = (await res.json()) as RevealResult & {
        status: string;
        assetId?: number;
      };

      // The prize was rolled but the wallet isn't opted into the won asset yet:
      // opt into that ONE asset (free), then call back. The server's draw is
      // deterministic for this payment, so the recompute lands on the same
      // prize and delivers it.
      if (data.status === "needs-optin") {
        // Guard against looping if the opt-in somehow isn't seen on the retry.
        if (optInAttempted) {
          throw new Error("Couldn't confirm your prize opt-in. Please tap Retry.");
        }
        if (!data.assetId) {
          throw new Error("Couldn't finish opening your loot box. Please tap Retry.");
        }
        // Show what they won so "approve to receive" isn't a blind signature.
        if (data.prize) setPendingPrize(data.prize);
        setSignContext("optin");
        setState("signing");
        await ensureOptedIn(address, data.assetId);
        await callServerReveal(address, paymentTxId, revealTxId, true);
        return;
      }

      setPendingReveal(null);
      setPendingPrize(null);
      setResult(data);
      setState("success");

      fetch("/api/lootbox/prizes")
        .then((r) => r.json())
        .then((d) => { if (d.prizes) setPrizes(d.prizes); })
        .catch(() => {});
    },
    [ensureOptedIn]
  );

  /* ---------------------------------------------------------------- */
  /*  Open Loot Box handler                                           */
  /* ---------------------------------------------------------------- */

  const handleOpenLootBox = useCallback(async () => {
    if (!walletAddress || !signTransactions) return;
    if (processingRef.current) return;
    processingRef.current = true;
    const myAttempt = ++attemptRef.current;

    setError(null);
    setResult(null);
    setPendingPrize(null);
    setWalletResetNeeded(false);
    setVrfProgress("");
    setQuip(WAIT_QUIPS[Math.floor(Math.random() * WAIT_QUIPS.length)]);
    setState("committing");
    // The modal opens when there's something to show (the wallet prompt or the
    // draw progress) — not during the brief commit fetch — so it doesn't flash
    // a half-second card. The button shows "Opening…" meanwhile.

    let commitSubmitted = false;

    try {
      const algodClient = new algosdk.Algodv2("", ALGOD_BASE_URL, "");

      // ---- Resume an in-flight open ---------------------------------
      const retrying =
        pendingReveal && pendingReveal.walletAddress === walletAddress;

      if (retrying) {
        commitSubmitted = true;
        setShowModal(true);

        // commitRound 0 means the payment was submitted but never confirmed
        // (browser closed between sendRawTransaction and waitForConfirmation).
        if (pendingReveal.commitRound === 0) {
          setPendingReveal(null);
          throw new Error(
            "A previous payment may have been submitted but was not confirmed. " +
            "Check your wallet transaction history. If the payment went through, " +
            "please contact support."
          );
        }

        if (pendingReveal.mode === "beacon") {
          // Beacon commits expire after the contract's reveal window.
          const status = (await algodClient.status().do()) as unknown as Record<string, unknown>;
          const currentRound = Number(status["lastRound"] ?? status["last-round"] ?? 0);
          if (currentRound > pendingReveal.commitRound + 900) {
            const lostPaymentTxId = pendingReveal.paymentTxId;
            setPendingReveal(null);
            throw new Error(
              `Your previous session expired before the prize could be claimed. Please contact support with this payment ID: ${lostPaymentTxId}`
            );
          }

          if (pendingReveal.revealTxId) {
            await callServerReveal(
              walletAddress,
              pendingReveal.paymentTxId,
              pendingReveal.revealTxId
            );
            return;
          }

          setState("waiting-vrf");
          await waitForVrfRounds(algodClient, pendingReveal.commitRound);

          setState("revealing");
          let revealTxId: string;
          try {
            revealTxId = await submitOnChainReveal(algodClient, walletAddress);
          } catch (revealErr) {
            // The server has since switched to block-seed mode: there's no
            // on-chain reveal anymore, but the payment is still redeemable —
            // the block-seed draw derives from the payment itself.
            if (
              revealErr instanceof Error &&
              revealErr.message.includes("only used in beacon mode")
            ) {
              await callServerReveal(walletAddress, pendingReveal.paymentTxId);
              return;
            }
            throw revealErr;
          }
          if (attemptRef.current !== myAttempt) return;
          setPendingReveal((prev) => prev ? { ...prev, revealTxId } : null);

          await callServerReveal(walletAddress, pendingReveal.paymentTxId, revealTxId);
          return;
        }

        // Block-seed resume: the payment is on-chain; the server recomputes
        // the draw and delivers (or asks for the opt-in).
        await callServerReveal(walletAddress, pendingReveal.paymentTxId);
        return;
      }

      /* ---- Fresh open ------------------------------------------------ */

      // Pre-flight: can this wallet actually afford the open? Check spendable
      // balance (total minus the locked min-balance) before asking for a
      // signature, so a short wallet gets a clear message instead of a cryptic
      // wallet/chain rejection after signing.
      try {
        const acct = (await algodClient
          .accountInformation(walletAddress)
          .do()) as unknown as Record<string, unknown>;
        const microBalance = Number(acct.amount ?? 0);
        const microMinBalance = Number(acct.minBalance ?? acct["min-balance"] ?? 100_000);
        const neededMicro = lootboxConfig.cratePriceMicroAlgo + 10_000; // + fee headroom
        if (microBalance - microMinBalance < neededMicro) {
          throw new Error(
            `Not enough ALGO in your wallet. You need about ${lootboxConfig.cratePrice} ALGO (plus a little for network fees) to open a loot box. Please top up and try again.`
          );
        }
      } catch (balanceErr) {
        if (balanceErr instanceof Error && balanceErr.message.startsWith("Not enough ALGO")) {
          throw balanceErr;
        }
        // Account lookup failed (e.g. brand-new account) — let the flow
        // proceed; the wallet/chain will reject an underfunded payment.
      }

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
      const randomnessMode: RandomnessMode =
        commitData.randomnessMode === "beacon" ? "beacon" : "block-seed";

      const paymentTxns = (commitData.unsignedTxns as string[]).map(
        (b64: string) =>
          algosdk.decodeUnsignedTransaction(
            new Uint8Array(Buffer.from(b64, "base64"))
          )
      );

      // The wallet prompt: sign the payment (block-seed: a single payment;
      // beacon: payment + commit app call, one prompt either way). The modal
      // opens here, right as the wallet popup appears — no pre-flash.
      setSignContext("payment");
      setShowModal(true);
      setState("signing");
      const signedAll = await signTransactions(
        paymentTxns.map((txn) => algosdk.encodeUnsignedTransaction(txn))
      );
      // The user tapped Cancel while the wallet prompt was open — don't submit.
      if (attemptRef.current !== myAttempt) return;
      if (signedAll.length !== paymentTxns.length) {
        throw new Error("Wallet returned unexpected number of signed transactions.");
      }
      const signedFiltered = signedAll.map(function (s) {
        if (!s) throw new Error("Wallet declined to sign a required transaction.");
        return s;
      });

      const paymentTxId =
        (commitData.paymentTxId as string | undefined) ?? (commitData.txIds[0] as string);

      // Save a recovery record BEFORE submitting so that if the browser
      // crashes between sendRawTransaction and waitForConfirmation the
      // user's payment is not silently lost. commitRound 0 signals
      // "submitted but not yet confirmed" to the recovery path.
      setPendingReveal({
        walletAddress,
        paymentTxId,
        mode: randomnessMode,
        commitRound: 0,
      });

      setState("distributing");
      const { txid: submitTxid } = await algodClient
        .sendRawTransaction(signedFiltered)
        .do();
      const confirmResult = (await algosdk.waitForConfirmation(
        algodClient,
        submitTxid as string,
        10
      )) as unknown as Record<string, unknown>;

      commitSubmitted = true;
      const commitRound = Number(
        confirmResult["confirmedRound"] ?? confirmResult["confirmed-round"] ?? 0
      );

      setPendingReveal({
        walletAddress,
        paymentTxId,
        mode: randomnessMode,
        commitRound,
      });

      if (!isLive) {
        // Preview mode: no on-chain reveal needed, call server directly.
        await callServerReveal(walletAddress, paymentTxId);
        return;
      }

      if (randomnessMode === "beacon") {
        setState("waiting-vrf");
        await waitForVrfRounds(algodClient, commitRound);

        setState("revealing");
        let revealTxId: string;
        try {
          revealTxId = await submitOnChainReveal(algodClient, walletAddress);
        } catch (revealErr) {
          // Server switched to block-seed mid-flight — the payment is still
          // redeemable via the block-seed draw.
          if (
            revealErr instanceof Error &&
            revealErr.message.includes("only used in beacon mode")
          ) {
            await callServerReveal(walletAddress, paymentTxId);
            return;
          }
          throw revealErr;
        }
        if (attemptRef.current !== myAttempt) return;
        setPendingReveal((prev) => prev ? { ...prev, revealTxId } : null);

        await callServerReveal(walletAddress, paymentTxId, revealTxId);
        return;
      }

      // Block-seed: the server waits for the next block seeds, draws the
      // prize, and delivers it — nothing else to sign (unless an opt-in is
      // needed for a won asset).
      await callServerReveal(walletAddress, paymentTxId);
    } catch (err: unknown) {
      // If this attempt was cancelled/superseded, swallow any late error.
      if (attemptRef.current !== myAttempt) return;
      const msg = err instanceof Error ? err.message : "Something went wrong";
      const lower = msg.toLowerCase();

      const isUserRejection =
        /cancel/i.test(msg) ||
        /reject/i.test(msg) ||
        /denied/i.test(msg) ||
        /abort/i.test(msg) ||
        /user.*close/i.test(msg);

      if (isUserRejection) {
        // Only clear pendingReveal if the payment hasn't been submitted yet.
        // If the user declines a later signature after paying, they need
        // pendingReveal to retry and claim their prize.
        if (!commitSubmitted) {
          setPendingReveal(null);
        }
        setState("idle");
        setShowModal(false);
        return;
      }

      // A stuck wallet session (e.g. a "request pending" left by a sign that
      // was abandoned by a reload) won't clear itself — surface a Reconnect
      // action that resets the session so the next attempt starts clean.
      const sessionStuck =
        lower.includes("request pending") ||
        lower.includes("another request") ||
        lower.includes("request that is in progress") ||
        lower.includes("no matching key") ||
        lower.includes("session topic") ||
        lower.includes("pairing");
      if (sessionStuck) {
        setWalletResetNeeded(true);
        setError(
          "Your wallet has a stuck request from an earlier attempt. Tap Reconnect Wallet to reset it, then open a loot box again."
        );
        setState("error");
        setShowModal(true);
        return;
      }

      console.error("[lootbox] open failed:", err);
      setError(humanizeError(msg));
      setState("error");
      // Ensure the error is visible even if it failed before the modal opened.
      setShowModal(true);
    } finally {
      // Only clear the guard if we're still the current attempt — a cancel may
      // have started a fresh attempt that owns the flag now.
      if (attemptRef.current === myAttempt) processingRef.current = false;
    }
  }, [walletAddress, signTransactions, callServerReveal, pendingReveal]);

  /* ---------------------------------------------------------------- */
  /*  Cancel a wallet-signature wait                                  */
  /* ---------------------------------------------------------------- */

  // Back out of a signature prompt that's going nowhere (e.g. the wallet app
  // never opened). Bumping attemptRef invalidates the in-flight attempt so a
  // signature that resolves later can't slip a payment through. Nothing is
  // submitted in the payment phase, so the pending open is cleared; in the
  // opt-in phase the payment already happened, so it's kept for resume.
  const handleCancelSigning = useCallback(() => {
    attemptRef.current += 1;
    processingRef.current = false;
    setShowModal(false);
    setState("idle");
    setError(null);
    if (signContext === "payment") setPendingReveal(null);
  }, [signContext]);

  /* ---------------------------------------------------------------- */
  /*  Reset a stuck wallet session                                    */
  /* ---------------------------------------------------------------- */

  const handleResetWallet = useCallback(async () => {
    setShowModal(false);
    setState("idle");
    setError(null);
    setWalletResetNeeded(false);
    try {
      await disconnectWallet();
    } catch {
      // best effort — the user can disconnect manually
    }
  }, [disconnectWallet]);

  /* ---------------------------------------------------------------- */
  /*  Retry handler                                                   */
  /* ---------------------------------------------------------------- */

  const handleRetry = useCallback(() => {
    if (pendingReveal && walletAddress && pendingReveal.walletAddress === walletAddress) {
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
    setPendingPrize(null);
    setWalletResetNeeded(false);
  }, [state]);

  // "Play Again" fires after closeModal settles state to idle + pendingReveal=null.
  // Using a flag avoids a stale closure capturing the old pendingReveal.
  useEffect(() => {
    if (playAgainFlag && state === "idle" && !pendingReveal) {
      setPlayAgainFlag(false);
      handleOpenLootBox();
    }
  }, [playAgainFlag, state, pendingReveal, handleOpenLootBox]);

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */

  const isProcessing =
    state === "committing" ||
    state === "signing" ||
    state === "waiting-vrf" ||
    state === "revealing" ||
    state === "distributing";

  // Once the won prize is known but not yet delivered (the opt-in + delivery
  // steps), show it the whole time instead of a generic spinner.
  const showClaim =
    !!pendingPrize && (state === "signing" || state === "distributing");

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
                Getting ready...
              </p>
            )}
            {state === "signing" && (
              <p className="text-sm text-zinc-400">
                Approve in your wallet...
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
                Opening your loot box...
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
                : state === "committing"
                ? "Opening…"
                : isProcessing
                ? "Processing..."
                : pendingReveal && pendingReveal.walletAddress === walletAddress
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
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center ${
            // Drop the blur while the wallet's signing popup is open so the
            // wallet UI renders crisply on top of our overlay.
            state === "signing" ? "bg-black/40" : "bg-black/70 backdrop-blur-sm"
          }`}
        >
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

            {/* Won prize awaiting opt-in / delivery */}
            {showClaim && pendingPrize && (
              <div className="flex flex-col items-center gap-4 py-4 text-center">
                <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
                  You Won!
                </p>
                <div
                  className={`flex h-24 w-24 items-center justify-center rounded-2xl border-2 ${
                    RARITY_BG[pendingPrize.rarity]
                  } ${RARITY_GLOW[pendingPrize.rarity]}`}
                >
                  <span className="text-4xl select-none">
                    {RARITY_EMOJI[pendingPrize.rarity]}
                  </span>
                </div>
                <div>
                  <p
                    className="text-xs font-semibold uppercase tracking-widest"
                    style={{ color: pendingPrize.color }}
                  >
                    {pendingPrize.rarity}
                  </p>
                  <h3 className="mt-1 text-xl font-bold text-zinc-100">
                    {pendingPrize.name}
                  </h3>
                </div>
                <p className="max-w-[300px] text-sm text-zinc-400">
                  {state === "signing"
                    ? "One tap to receive it — approve the opt-in in your wallet. There's no charge for this step."
                    : "Delivering it to your wallet — just a moment…"}
                </p>
                {state === "signing" && (
                  // The payment is done and the prize is held for this wallet —
                  // backing out keeps it claimable later via Retry.
                  <button
                    onClick={handleCancelSigning}
                    className="text-xs uppercase tracking-widest text-zinc-500 underline-offset-4 transition hover:text-zinc-300 hover:underline"
                  >
                    Do this later
                  </button>
                )}
              </div>
            )}

            {/* Waiting for wallet approval (payment) */}
            {!showClaim && state === "signing" && (
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
                {/* Always give an escape hatch while waiting on the wallet —
                    if the wallet app never opens, the user isn't trapped. */}
                <button
                  onClick={handleCancelSigning}
                  className="mt-1 text-xs uppercase tracking-widest text-zinc-500 underline-offset-4 transition hover:text-zinc-300 hover:underline"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Beacon mode: waiting for the VRF round */}
            {state === "waiting-vrf" && (
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-amber-500 border-t-transparent" />
                <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">
                  Generating Randomness
                </p>
                <p className="text-sm text-zinc-400">
                  {vrfProgress || "Waiting for the on-chain VRF round..."}
                </p>
                <p className="text-xs text-zinc-600">
                  This takes about 30 seconds — please keep this window open
                </p>
              </div>
            )}

            {/* Beacon mode: signing the on-chain reveal */}
            {state === "revealing" && (
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="h-12 w-12 animate-pulse rounded-full border-4 border-indigo-400/50 bg-indigo-500/10" />
                <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
                  Almost There
                </p>
                <p className="text-sm text-zinc-400">
                  Approve the reveal in your wallet — there&apos;s no charge for this step.
                </p>
              </div>
            )}

            {/* Drawing + delivering the prize (one screen, no flicker) */}
            {!showClaim && (state === "committing" || state === "distributing") && (
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
                <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
                  Opening Your Loot Box
                </p>
                <p className="max-w-[300px] text-center text-sm italic text-zinc-300">
                  {quip}
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
                    {RARITY_EMOJI[result.prize.rarity]}
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
                      setPlayAgainFlag(true);
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
                {pendingReveal && pendingReveal.walletAddress === walletAddress && !walletResetNeeded && (
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
                    onClick={walletResetNeeded ? handleResetWallet : handleRetry}
                    className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
                  >
                    {walletResetNeeded
                      ? "Reconnect Wallet"
                      : pendingReveal && pendingReveal.walletAddress === walletAddress
                      ? "Retry"
                      : "Try Again"}
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
