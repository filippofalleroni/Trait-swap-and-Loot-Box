"use client";

import type { ReactNode } from "react";
import { useWallet } from "@/contexts/wallet-context";
import { isAdminWallet } from "@/config/admin";
import { ConnectWalletButtonModal } from "@/components/connect-wallet-button";

export default function AdminGate({ children }: { children: ReactNode }) {
  const { isConnected, walletAddress } = useWallet();

  // Not connected — prompt the user to connect before showing access denied
  if (!isConnected || !walletAddress) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/80 p-8 text-center shadow-[0_20px_60px_rgba(0,0,0,0.3)]">
          <h2 className="text-2xl font-bold text-zinc-100">Admin Access</h2>
          <p className="mt-3 text-sm text-zinc-400">
            Connect an authorized wallet to continue.
          </p>
          <div className="mt-6 flex justify-center">
            <ConnectWalletButtonModal />
          </div>
        </div>
      </div>
    );
  }

  // Connected but not admin — deny access and show truncated address
  if (!isAdminWallet(walletAddress)) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-red-900/40 bg-zinc-900/80 p-8 text-center shadow-[0_20px_60px_rgba(0,0,0,0.3)]">
          <h2 className="text-2xl font-bold text-red-400">Access Denied</h2>
          <p className="mt-3 text-sm text-zinc-400">
            This wallet is not authorized for admin access.
          </p>
          <p className="mt-2 font-mono text-[11px] text-zinc-600">
            {walletAddress.slice(0, 8)}...{walletAddress.slice(-6)}
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
