"use client";

import React from "react";
import { useWallet } from "@/contexts/wallet-context";
import { isAdminWallet } from "@/config/admin";

export default function AdminGate({ children }: { children: React.ReactNode }) {
  const { walletAddress, isConnected } = useWallet();

  if (!isConnected || !isAdminWallet(walletAddress)) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-red-900/40 bg-zinc-900/60 p-10 text-center">
        <h2 className="text-xl font-semibold text-red-400">Access Denied</h2>
        <p className="text-sm text-zinc-400">
          Your wallet is not authorized to view this page.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
