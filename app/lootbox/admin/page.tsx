import AdminGate from "@/components/admin-gate";
import LootboxAdmin from "@/components/lootbox-admin";

export const metadata = {
  title: "Loot Box Admin",
  description: "Admin panel for loot box configuration.",
};

export default function LootboxAdminPage() {
  return (
    <main className="min-h-screen bg-zinc-950 p-4 sm:p-8">
      <AdminGate>
        <LootboxAdmin />
      </AdminGate>
    </main>
  );
}
