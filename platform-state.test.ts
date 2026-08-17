import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlatformStateStore, SlidingWindowRateLimiter } from './platform-state';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rbh-platform-state-'));
const previousKey = process.env.DATA_ENCRYPTION_KEY;
process.env.DATA_ENCRYPTION_KEY = 'test-only-encryption-key';

try {
  const store = new PlatformStateStore(temporary);
  const state = store.get();
  state.sessions['123'] = {
    tokenCA: '0xbb067737314e04b350c1d35e4784bcbc98405855',
    running: true,
    paused: false,
    package: 'test',
    mode: 'volume',
    durationMs: 60_000,
    wallets: [{ privateKey: '0xsecret-wallet-key' }],
    startTime: Date.now(),
    endTime: Date.now() + 60_000,
    orderId: 'order_test',
    completedBuys: 1,
    completedSells: 0,
    failedSwaps: 0,
    lastActivityAt: Date.now(),
  };
  state.bumpWalletPools['123'] = [{ privateKey: '0xreusable-bump-key' }];
  store.save();

  const encrypted = fs.readFileSync(path.join(temporary, 'platform-state.enc'), 'utf8');
  assert.equal(encrypted.includes('secret-wallet-key'), false, 'private keys must not be written as plaintext');
  assert.equal(encrypted.includes('reusable-bump-key'), false, 'reusable bump keys must be encrypted');

  const restored = new PlatformStateStore(temporary).get();
  assert.equal(restored.sessions['123'].orderId, 'order_test');
  assert.equal(restored.sessions['123'].wallets[0].privateKey, '0xsecret-wallet-key');
  assert.equal(restored.bumpWalletPools['123'][0].privateKey, '0xreusable-bump-key');

  const limiter = new SlidingWindowRateLimiter();
  assert.equal(limiter.allow(1, 2, 10_000), true);
  assert.equal(limiter.allow(1, 2, 10_000), true);
  assert.equal(limiter.allow(1, 2, 10_000), false);

  console.log('platform-state tests passed');
} finally {
  if (previousKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
  else process.env.DATA_ENCRYPTION_KEY = previousKey;
  fs.rmSync(temporary, { recursive: true, force: true });
}
