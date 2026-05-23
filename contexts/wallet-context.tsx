"use client";

import {
  NetworkId,
  WalletId,
  WalletManager,
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

  useEffect(() => {
    const unsubscribe = manager.subscribe(() => {
      setVersion((v) => v + 1);
    });

    void manager.resumeSessions().finally(() => {
      setVersion((v) => v + 1);
    });

    return unsubscribe;
  }, [manager]);

  const value = useMemo<WalletContextValue>(() => {
    return {
      isConnected: Boolean(manager.activeAddress),
      isReady: manager.isReady,
      isConnecting,
      walletAddress: manager.activeAddress,
      activeWalletName: manager.activeWallet?.metadata?.name ?? null,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, version, isConnecting]);

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
