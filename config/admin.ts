// Admin wallet addresses — these wallets can access the admin panel.
// Set via ADMIN_WALLETS env var (comma-separated) or hardcode here.
const ENV_ADMIN_WALLETS = (process.env.ADMIN_WALLETS ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

export const ADMIN_WALLETS: string[] = ENV_ADMIN_WALLETS.length > 0
  ? ENV_ADMIN_WALLETS
  : [
      // Add your admin wallet addresses here if not using env var:
      // "ABCDEF...",
    ];

export function isAdminWallet(address: string | null): boolean {
  if (!address) return false;
  const normalized = address.toUpperCase();
  return ADMIN_WALLETS.some(function (a) { return a.toUpperCase() === normalized; });
}
