import React from "react";
import WalletGate from "@/components/wallet-gate";
import TraitSwapper from "@/components/trait-swapper";

export const metadata = {
  title: "Trait Lab",
  description: "Swap and customize traits on your NFTs.",
};

export default function TraitLabPage() {
  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100 sm:text-4xl">
            Trait Lab
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Browse, preview, and apply new traits to your collection NFTs.
          </p>
        </div>

        {/* Wallet gate wraps the trait swapper */}
        <WalletGate title="Trait Lab">
          <TraitSwapper />
        </WalletGate>
      </div>
    </main>
  );
}
