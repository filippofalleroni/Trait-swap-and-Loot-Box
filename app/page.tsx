import Link from "next/link";

const features = [
  {
    href: "/trait-lab",
    title: "Trait Lab",
    description: "Swap and customize traits on your NFTs",
  },
  {
    href: "/lootbox",
    title: "Loot Box",
    description: "Open loot boxes for a chance to win prizes",
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-24">
      {/* Hero */}
      <section className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-bold tracking-tight text-zinc-100 sm:text-5xl">
          TraitSwap &amp; LootBox
        </h1>
        <p className="mt-4 text-lg text-zinc-400">
          Open-source NFT trait swapper and loot box system for Algorand
        </p>
      </section>

      {/* Feature cards */}
      <section className="mx-auto mt-16 grid w-full max-w-3xl gap-6 sm:grid-cols-2">
        {features.map((feature) => (
          <Link
            key={feature.href}
            href={feature.href}
            className="group rounded-xl border border-zinc-800 bg-zinc-900/60 p-8 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
          >
            <h2 className="text-xl font-semibold text-zinc-100 group-hover:text-indigo-400 transition-colors">
              {feature.title}
            </h2>
            <p className="mt-2 text-sm text-zinc-400">
              {feature.description}
            </p>
          </Link>
        ))}
      </section>
    </main>
  );
}
