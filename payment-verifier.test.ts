import assert from 'node:assert/strict';
import { blockscoutCandidateHashes, extractPaymentTxHash, matchesPayment } from './payment-verifier';

const hash = `0x${'ab'.repeat(32)}`;
const otherHash = `0x${'cd'.repeat(32)}`;
const destination = '0x11DC9eB9004e4F0253FCD3Bd660350FE93cDcEC1';

assert.equal(extractPaymentTxHash(`PAID ${hash}`), hash);
assert.equal(extractPaymentTxHash(`https://example.test/tx/${hash}?tab=index`), hash);
assert.equal(extractPaymentTxHash('PAID'), undefined);

const match = {
  expectedWei: 20_000n,
  createdBlock: 100n,
  destination,
  claimedHashes: new Set<string>(),
};

assert.equal(matchesPayment({ hash, to: destination.toLowerCase(), value: 20_000n, blockNumber: 101n, succeeded: true }, match), true);
assert.equal(matchesPayment({ hash, to: destination, value: 19_999n, blockNumber: 101n, succeeded: true }, match), false);
assert.equal(matchesPayment({ hash, to: destination, value: 20_001n, blockNumber: 101n, succeeded: true }, match), false);
assert.equal(matchesPayment({ hash, to: destination, value: 20_001n, blockNumber: 101n, succeeded: true }, { ...match, allowOverpayment: true }), true);
assert.equal(matchesPayment({ hash, to: destination, value: 20_000n, blockNumber: 99n, succeeded: true }, match), false);
assert.equal(matchesPayment({ hash, to: destination, value: 20_000n, blockNumber: 101n, succeeded: false }, match), false);
assert.equal(matchesPayment({ hash, to: destination, value: 20_000n, blockNumber: 101n, succeeded: true }, { ...match, claimedHashes: new Set([hash]) }), false);

const blockscout = {
  items: [
    { hash, to: { hash: destination }, value: '20000', block_number: 101, status: 'ok' },
    { hash: otherHash, to: { hash: destination }, value: '19999', block_number: 102, status: 'ok' },
  ],
};
assert.deepEqual(blockscoutCandidateHashes(blockscout, match), [hash]);
assert.deepEqual(blockscoutCandidateHashes({ items: 'bad' }, match), []);

console.log('payment verifier tests passed');
