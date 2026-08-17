import assert from 'node:assert/strict';
import {
  BUMP_BUY_CONCURRENCY, BUMP_BUY_ETH, bumpBuyRounds, bumpReuseCount, bumpRoundWalletCount,
  bumpSellerCount, bumpWalletCount,
} from './bump-config';

assert.equal(BUMP_BUY_ETH, '0.00001');
assert.equal(BUMP_BUY_CONCURRENCY, 10);
assert.deepEqual(['test', 'starter', 'dolphin', 'whale', 'max'].map(bumpWalletCount), [30, 40, 50, 70, 100]);
assert.equal(bumpBuyRounds(() => 0), 6);
assert.equal(bumpBuyRounds(() => 0.999999), 12);
assert.equal(bumpRoundWalletCount(100, () => 0), 72);
assert.equal(bumpRoundWalletCount(100, () => 0.999999), 100);
assert.equal(bumpSellerCount(100, () => 0), 20);
assert.equal(bumpSellerCount(100, () => 0.999999), 35);
assert.equal(bumpReuseCount(12, 0), 0);
assert.equal(bumpReuseCount(12, 20), 8);
assert.equal(bumpReuseCount(100, 60), 60);

console.log('bump config tests passed');
