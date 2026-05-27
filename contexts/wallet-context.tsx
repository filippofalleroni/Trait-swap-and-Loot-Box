"use client";

import {
  NetworkId,
  WalletId,
  WalletManager,
  type BaseWallet,
} from "@txnlab/use-wallet";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type SupportedWalletId = "pera" | "defly" | "lute";

type WalletContextValue = {
  isConnected: boolean;
  isReady: boolean;
  isConnecting: boolean;
  walletAddress: string | null;
  walletDisplayName: string | null;
  activeWalletName: string | null;
  connectWallet: (walletId: SupportedWalletId) => Promise<void>;
  disconnectWallet: () => Promise<void>;
  signTransactions: (
    txns: Uint8Array[],
    indexesToSign?: number[]
  ) => Promise<(Uint8Array | null)[]>;
};

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

const WALLET_ID_MAP: Record<SupportedWalletId, WalletId> = {
  pera: WalletId.PERA,
  defly: WalletId.DEFLY,
  lute: WalletId.LUTE,
};

function getWalletLabel(wallet: BaseWallet | null) {
  return wallet?.name ?? null;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [manager] = useState(
    () =>
      new WalletManager({
        wallets: [WalletId.PERA, WalletId.DEFLY, WalletId.LUTE],
        defaultNetwork: NetworkId.MAINNET,
      })
  );
  const [version, setVersion] = useState(0);
  const [isConnecting, setIsConnecting] = useState(false);
  const [walletDisplayName, setWalletDisplayName] = useState<string | null>(
    null
  );

  useEffect(() => {
    const unsubscribe = manager.subscribe(() => {
      setVersion((v) => v + 1);
    });

    void manager.resumeSessions().finally(() => {
      setVersion((v) => v + 1);
    });

    return unsubscribe;
  }, [manager]);

  // Resolve NFD display name whenever the active address changes
  useEffect(() => {
    const activeAddress = manager.activeAddress;

    if (!activeAddress) {
      setWalletDisplayName(null);
      return;
    }

    let isCancelled = false;

    async function loadWalletDisplayName() {
      try {
        const response = await fetch(
          `/api/nfd?address=${encodeURIComponent(activeAddress!)}`,
          { cache: "no-store" }
        );

        if (!response.ok) {
          throw new Error(`NFD API failed with status ${response.status}`);
        }

        const data = (await response.json()) as { nfd?: string | null };
        if (!isCancelled) {
          setWalletDisplayName(data.nfd ?? null);
        }
      } catch (error) {
        console.error("Failed to resolve wallet NFD", error);
        if (!isCancelled) {
          setWalletDisplayName(null);
        }
      }
    }

    void loadWalletDisplayName();

    return () => {
      isCancelled = true;
    };
  }, [manager.activeAddress]);

  const value = useMemo<WalletContextValue>(() => {
    const activeWallet = manager.activeWallet;

    return {
      isConnected: Boolean(manager.activeAddress),
      isReady: manager.isReady,
      isConnecting,
      walletAddress: manager.activeAddress,
      walletDisplayName,
      activeWalletName: getWalletLabel(activeWallet),
      connectWallet: async (walletId: SupportedWalletId) => {
        const targetId = WALLET_ID_MAP[walletId];
        const wallet = manager.getWallet(targetId);
        if (!wallet) throw new Error(`${walletId} wallet not available`);
        setIsConnecting(true);
        try {
          await wallet.connect();
          wallet.setActive();
          setVersion((v) => v + 1);
        } finally {
          setIsConnecting(false);
        }
      },
      disconnectWallet: async () => {
        await manager.disconnect();
        setVersion((v) => v + 1);
      },
      signTransactions: async (txns, indexesToSign) => {
        const wallet = manager.activeWallet;
        if (!wallet) throw new Error("No wallet connected");
        return await wallet.signTransactions(txns, indexesToSign);
      },
    };
  }, [isConnecting, manager, walletDisplayName, version]);

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error("useWallet must be used inside WalletProvider");
  }
  return context;
}
