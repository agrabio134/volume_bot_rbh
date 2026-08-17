import { fallback, http } from 'viem';

export const robinhood = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://localhost:8545'] } },
} as const;

export const HUH_TOKEN = '0xbb067737314e04b350c1d35e4784bcbc98405855' as const;
export const WETH_TOKEN = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const;
export const HUH_WETH_POOL = '0xAB47f8FB0b6BD56F5B65cC2578f4329CE68547Ca' as const;
export const POOL_FEE = 10_000;
export const SWAP_ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2' as const;
export const QUOTER_V2 = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' as const;
export const V4_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as const;
export const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as const;
export const UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904' as const;
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const;
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000' as const;
export const COMMISSION_WALLET = '0x1490bB810798db9cD977B7737cC8bEaB5C922e35' as const;
export const CONTROLLER_WALLET = '0x11DC9eB9004e4F0253FCD3Bd660350FE93cDcEC1' as const;

export function getRpcUrl(): string {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error('RPC_URL is required for Robinhood Chain (chain ID 4663)');
  return rpcUrl;
}

export function getRpcUrls(): string[] {
  const configured = [process.env.RPC_URL, process.env.RPC_URL_BACKUP, ...(process.env.RPC_URLS || '').split(',')]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value));
  const unique = [...new Set(configured)];
  if (!unique.length) throw new Error('RPC_URL is required for Robinhood Chain (chain ID 4663)');
  return unique;
}

export function getRpcTransport() {
  const transports = getRpcUrls().map(url => http(url, { timeout: 12_000, retryCount: 2 }));
  return transports.length === 1 ? transports[0] : fallback(transports, { rank: true, retryCount: 1 });
}
