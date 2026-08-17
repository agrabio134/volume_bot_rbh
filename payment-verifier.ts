export const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export type PaymentCandidate = {
  hash: string;
  to?: string | null;
  value: bigint;
  blockNumber: bigint;
  succeeded: boolean;
};

export type PaymentMatch = {
  expectedWei: bigint;
  createdBlock: bigint;
  destination: string;
  claimedHashes: ReadonlySet<string>;
  allowOverpayment?: boolean;
};

export function extractPaymentTxHash(text: string): `0x${string}` | undefined {
  const match = text.match(/0x[0-9a-fA-F]{64}/);
  if (!match || !TRANSACTION_HASH_PATTERN.test(match[0])) return undefined;
  return match[0] as `0x${string}`;
}

export function matchesPayment(candidate: PaymentCandidate, match: PaymentMatch): boolean {
  return candidate.succeeded &&
    candidate.blockNumber >= match.createdBlock &&
    candidate.to?.toLowerCase() === match.destination.toLowerCase() &&
    (match.allowOverpayment ? candidate.value >= match.expectedWei : candidate.value === match.expectedWei) &&
    !match.claimedHashes.has(candidate.hash.toLowerCase());
}

type BlockscoutTransaction = {
  hash?: unknown;
  value?: unknown;
  block_number?: unknown;
  status?: unknown;
  to?: { hash?: unknown } | null;
};

export function blockscoutCandidateHashes(
  payload: unknown,
  match: PaymentMatch,
): `0x${string}`[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const hashes: `0x${string}`[] = [];
  for (const raw of items) {
    const item = raw as BlockscoutTransaction;
    if (typeof item.hash !== 'string' || !TRANSACTION_HASH_PATTERN.test(item.hash)) continue;
    if (typeof item.value !== 'string' || !/^\d+$/.test(item.value)) continue;
    if (typeof item.block_number !== 'number' && typeof item.block_number !== 'string') continue;
    const blockNumber = BigInt(item.block_number);
    const to = typeof item.to?.hash === 'string' ? item.to.hash : undefined;
    const candidate: PaymentCandidate = {
      hash: item.hash,
      to,
      value: BigInt(item.value),
      blockNumber,
      succeeded: item.status === 'ok',
    };
    if (matchesPayment(candidate, match)) hashes.push(item.hash as `0x${string}`);
  }
  return hashes;
}
