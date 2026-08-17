import assert from 'node:assert/strict';
import {
  BUMP_BUY_ETH, bumpBuyRounds, bumpReuseCount, bumpRoundWalletCount,
  bumpSellerCount, bumpWalletCount,
} from './bump-config';

assert.equal(BUMP_BUY_ETH, '0.00001');
assert.deepEqual(['test', 'starter', 'dolphin', 'whale', 'max'].map(bumpWalletCount), [8, 12, 16, 24, 32]);
assert.equal(bumpBuyRounds(() => 0), 6);
assert.equal(bumpBuyRounds(() => 0.999999), 12);
assert.equal(bumpRoundWalletCount(32, () => 0), 24);
assert.equal(bumpRoundWalletCount(32, () => 0.999999), 32);
assert.equal(bumpSellerCount(32, () => 0), 7);
assert.equal(bumpSellerCount(32, () => 0.999999), 12);
assert.equal(bumpReuseCount(12, 0), 0);
assert.equal(bumpReuseCount(12, 20), 8);
assert.equal(bumpReuseCount(32, 10), 10);

console.log('bump config tests passed');
