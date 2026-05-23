"use client";

import AdminGate from "@/components/admin-gate";

export default function LootboxAdminPage() {
  return (
    <main className="min-h-screen bg-zinc-950 p-4 sm:p-8">
      <AdminGate>
        <div className="mx-auto max-w-4xl">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-10 text-center">
            <h1 className="text-2xl font-bold text-zinc-100">
              Loot Box Admin Panel
            </h1>
            <p className="mt-3 text-sm text-zinc-400">
              Admin controls will be added here.
            </p>
          </div>
        </div>
      </AdminGate>
    </main>
  );
}
