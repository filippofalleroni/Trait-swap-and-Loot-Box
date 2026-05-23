"use client";

import React from "react";
import { WalletProvider } from "@/contexts/wallet-context";
import { ToastProvider } from "@/contexts/toast-context";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <ToastProvider>{children}</ToastProvider>
    </WalletProvider>
  );
}
