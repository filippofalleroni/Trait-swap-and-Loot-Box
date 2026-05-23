"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ConnectWalletButtonModal } from "@/components/connect-wallet-button";
import { useWallet } from "@/contexts/wallet-context";

export default function WalletGate({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  const { isConnected, isReady } = useWallet();
  const router = useRouter();
  const [canRender, setCanRender] = useState(isReady || isConnected);
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    if (isReady || isConnected) {
      setCanRender(true);
      return;
    }
    const loadingTimer = setTimeout(() => setShowLoading(true), 400);
    const fallbackTimer = setTimeout(() => setCanRender(true), 8000);
    return () => {
      clearTimeout(loadingTimer);
      clearTimeout(fallbackTimer);
    };
  }, [isReady, isConnected]);

  if (!canRender) {
    if (!showLoading) return null;
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-10 text-center">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-400 [animation-delay:0ms]" />
            <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-500 [animation-delay:200ms]" />
            <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-400 [animation-delay:400ms]" />
          </div>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">
            Reading Wallet
          </p>
        </div>
      </div>
    );
  }

  if (isConnected) return <>{children}</>;

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 text-center shadow-[0_20px_60px_rgba(0,0,0,0.3)] sm:p-8">
        <p className="text-[11px] uppercase tracking-[0.3em] text-indigo-400">
          Wallet Required
        </p>
        <h2 className="mt-2 text-2xl font-bold text-zinc-100 sm:text-3xl">
          {title}
        </h2>
        <p className="mx-auto mt-3 max-w-sm text-sm text-zinc-400">
          Connect your Algorand wallet to access {title} and start interacting
          with your NFTs.
        </p>
        <div className="mt-6 flex justify-center">
          <ConnectWalletButtonModal />
        </div>
        <button
          type="button"
          onClick={() => router.push("/")}
          className="mt-4 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
        >
          Go Back
        </button>
      </div>
    </div>
  );
}
