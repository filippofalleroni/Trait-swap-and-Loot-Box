"use client";

import WalletGate from "@/components/wallet-gate";
import LootboxStudio from "@/components/lootbox-studio";

export default function LootboxPage() {
  return (
    <main className="min-h-screen bg-zinc-950 p-4 sm:p-8">
      <WalletGate title="Loot Box">
        <LootboxStudio />
      </WalletGate>
    </main>
  );
}
