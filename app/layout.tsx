import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Providers from "@/components/providers";
import Header from "@/components/header";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "TraitSwap & LootBox",
  description:
    "Open-source NFT trait swapper and loot box for Algorand",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.className}>
      <body className="min-h-screen bg-zinc-950">
        <Providers>
          <Header />
          {children}
        </Providers>
      </body>
    </html>
  );
}
