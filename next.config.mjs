import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "ipfs.io", pathname: "/ipfs/**" },
      { protocol: "https", hostname: "gateway.pinata.cloud", pathname: "/ipfs/**" },
      { protocol: "https", hostname: "ipfs-pera.algonode.dev", pathname: "/**" },
      { protocol: "https", hostname: "ipfs.algonode.xyz", pathname: "/**" },
    ],
  },
  webpack: (config) => {
    // @txnlab/use-wallet bundles all wallet provider adapters, but many are
    // optional peer dependencies. Alias the ones we don't use to an empty
    // module so webpack doesn't fail when they're not installed.
    const optionalDeps = [
      "@web3auth/modal",
      "@web3auth/single-factor-auth",
      "@web3auth/base",
      "@web3auth/base-provider",
      "@algorandfoundation/liquid-auth-use-wallet-client",
      "@magic-sdk/algorand",
      "@magic-ext/algorand",
      "magic-sdk",
    ];

    for (const dep of optionalDeps) {
      config.resolve.alias[dep] = false;
    }

    return config;
  },
};

export default nextConfig;
