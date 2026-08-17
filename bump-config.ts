export const BUMP_BUY_ETH = '0.00001';
export const BUMP_BUY_CONCURRENCY = 10;

export const BUMP_WALLET_COUNTS: Record<string, number> = {
  test: 30,
  starter: 40,
  dolphin: 50,
  whale: 70,
  max: 100,
};

export function bumpWalletCount(packageType: string): number {
  return BUMP_WALLET_COUNTS[packageType] ?? BUMP_WALLET_COUNTS.test;
}

export function bumpReuseCount(walletCount: number, existingPoolSize: number): number {
  if (existingPoolSize <= 0) return 0;
  return Math.min(existingPoolSize, Math.max(1, Math.floor(walletCount * 0.70)));
}

export function bumpBuyRounds(random = Math.random): number {
  return 6 + Math.floor(random() * 7);
}

export function bumpRoundWalletCount(walletCount: number, random = Math.random): number {
  return Math.max(1, Math.ceil(walletCount * (0.72 + random() * 0.28)));
}

export function bumpSellerCount(walletCount: number, random = Math.random): number {
  return Math.max(1, Math.ceil(walletCount * (0.20 + random() * 0.15)));
}
