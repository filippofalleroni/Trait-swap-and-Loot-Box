"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@/contexts/wallet-context";

function shortAddress(address: string | null) {
  if (!address) return null;
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function ConnectWalletButton() {
  return <ConnectWalletButtonInner menuMode="dropdown" />;
}

export function ConnectWalletButtonModal() {
  return <ConnectWalletButtonInner menuMode="modal" />;
}

const btnBase =
  "inline-flex min-h-[40px] items-center justify-center rounded-lg border-2 bg-transparent px-4 py-2 text-sm font-medium tracking-wide transition-all duration-150 focus:outline-none sm:min-h-[44px] sm:px-5 sm:py-2.5";

function ConnectWalletButtonInner({
  menuMode,
}: {
  menuMode: "dropdown" | "modal";
}) {
  const {
    isConnected,
    isConnecting,
    walletAddress,
    activeWalletName,
    connectWallet,
    disconnectWallet,
  } = useWallet();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isLogoutOpen, setIsLogoutOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const label = useMemo(() => {
    if (!isMounted) return "Connect Wallet";
    if (isConnecting) return "Connecting...";
    if (isConnected)
      return activeWalletName
        ? `${activeWalletName} · ${shortAddress(walletAddress)}`
        : shortAddress(walletAddress) ?? "Connected";
    return "Connect Wallet";
  }, [isConnected, isConnecting, isMounted, walletAddress, activeWalletName]);

  async function handleConnect(walletId: "pera" | "defly" | "lute") {
    try {
      await connectWallet(walletId);
      setIsMenuOpen(false);
    } catch (error) {
      console.error(`Failed to connect ${walletId} wallet`, error);
    }
  }

  const connectedColor = "rgb(52, 211, 153)";
  const defaultColor = "rgb(129, 140, 248)";
  const accent = isConnected && isMounted ? connectedColor : defaultColor;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          if (isConnected) {
            setIsMenuOpen(false);
            setIsLogoutOpen((v) => !v);
            return;
          }
          setIsLogoutOpen(false);
          setIsMenuOpen((v) => !v);
        }}
        className={btnBase}
        style={{ borderColor: accent, color: accent }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = accent;
          e.currentTarget.style.color = "#09090b";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = accent;
        }}
      >
        {label}
      </button>

      {isMenuOpen && menuMode === "dropdown" ? (
        <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-[210px] rounded-xl border border-zinc-700/60 bg-zinc-900 p-3 shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
          <p className="mb-3 px-1 text-[11px] uppercase tracking-[0.2em] text-zinc-500">
            Choose Wallet
          </p>
          <div className="grid gap-2">
            <button
              type="button"
              onClick={() => void handleConnect("pera")}
              disabled={isConnecting}
              className={`${btnBase} w-full border-sky-400 text-sky-400 hover:bg-sky-400 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40`}
            >
              Pera
            </button>
            <button
              type="button"
              onClick={() => void handleConnect("defly")}
              disabled={isConnecting}
              className={`${btnBase} w-full border-pink-400 text-pink-400 hover:bg-pink-400 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40`}
            >
              Defly
            </button>
            <button
              type="button"
              onClick={() => void handleConnect("lute")}
              disabled={isConnecting}
              className={`${btnBase} w-full border-amber-400 text-amber-400 hover:bg-amber-400 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40`}
            >
              Lute
            </button>
          </div>
        </div>
      ) : null}

      {isMenuOpen && menuMode === "modal" ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-[20rem] rounded-2xl border border-zinc-700/60 bg-zinc-900 p-5 shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
            <p className="mb-4 text-[11px] uppercase tracking-[0.2em] text-zinc-500">
              Choose Wallet
            </p>
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => void handleConnect("pera")}
                disabled={isConnecting}
                className={`${btnBase} w-full border-sky-400 text-sky-400 hover:bg-sky-400 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40`}
              >
                Pera
              </button>
              <button
                type="button"
                onClick={() => void handleConnect("defly")}
                disabled={isConnecting}
                className={`${btnBase} w-full border-pink-400 text-pink-400 hover:bg-pink-400 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40`}
              >
                Defly
              </button>
              <button
                type="button"
                onClick={() => void handleConnect("lute")}
                disabled={isConnecting}
                className={`${btnBase} w-full border-amber-400 text-amber-400 hover:bg-amber-400 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40`}
              >
                Lute
              </button>
            </div>
            <button
              type="button"
              onClick={() => setIsMenuOpen(false)}
              className={`${btnBase} mt-3 w-full border-zinc-600 text-zinc-400 hover:border-zinc-400 hover:bg-zinc-800 hover:text-zinc-200`}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      {isLogoutOpen ? (
        <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-[240px] rounded-xl border border-zinc-700/60 bg-zinc-900 p-4 shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
          <p className="text-sm font-medium text-zinc-100">Disconnect?</p>
          <p className="mt-1 text-[11px] text-zinc-500">
            {shortAddress(walletAddress) ?? "Wallet connected"}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setIsLogoutOpen(false)}
              className={`${btnBase} w-full border-zinc-600 text-zinc-400 hover:border-zinc-400 hover:bg-zinc-800 hover:text-zinc-200`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                void disconnectWallet();
                setIsLogoutOpen(false);
              }}
              className={`${btnBase} w-full border-red-400/70 text-red-400 hover:bg-red-400 hover:text-zinc-950`}
            >
              Log Out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
