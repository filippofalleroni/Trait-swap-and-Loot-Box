import AdminGate from "@/components/admin-gate";
import LootboxAdmin from "@/components/lootbox-admin";

export default function AdminPage() {
  return (
    <AdminGate>
      <LootboxAdmin />
    </AdminGate>
  );
}
