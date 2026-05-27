import WalletGate from "@/components/wallet-gate";
import LootboxStudio from "@/components/lootbox-studio";

export const metadata = {
  title: "Loot Box",
  description: "Open loot boxes for a chance to win prizes.",
};

export default function LootboxPage() {
  return (
    <main className="min-h-screen bg-zinc-950 p-4 sm:p-8">
      <WalletGate title="Loot Box">
        <LootboxStudio />
      </WalletGate>
    </main>
  );
}
