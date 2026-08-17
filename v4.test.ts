import assert from 'node:assert/strict';
import { decodeV4Plan, encodeV4ExactInputSingle, type V4PoolKey } from './v4';

const key: V4PoolKey = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x7E6335DFD2271b6F88072e10d8A6D0b591311b8A',
  fee: 2_500,
  tickSpacing: 25,
  hooks: '0x0000000000000000000000000000000000000000',
};

const deadline = 2_000_000_000n;
const data = encodeV4ExactInputSingle({
  poolKey: key,
  zeroForOne: true,
  amountIn: 100_000_000_000_000n,
  amountOutMinimum: 1n,
  currencyIn: key.currency0,
  currencyOut: key.currency1,
  deadline,
});
const decoded = decodeV4Plan(data);
assert.equal(decoded.commands, '0x10');
assert.equal(decoded.actions, '0x060f0c');
assert.equal(decoded.params.length, 3);
assert.equal(decoded.deadline, deadline);

console.log('v4 encoding tests passed');
