import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem';

export type V4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export const V4_POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

export const V4_POOL_MANAGER_ABI = [
  {
    name: 'Initialize', type: 'event', inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'currency0', type: 'address', indexed: true },
      { name: 'currency1', type: 'address', indexed: true },
      { name: 'fee', type: 'uint24', indexed: false },
      { name: 'tickSpacing', type: 'int24', indexed: false },
      { name: 'hooks', type: 'address', indexed: false },
      { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
      { name: 'tick', type: 'int24', indexed: false },
    ],
  },
] as const;

export const V4_QUOTER_ABI = [
  {
    name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
    inputs: [{
      name: 'params', type: 'tuple', components: [
        { name: 'poolKey', type: 'tuple', components: V4_POOL_KEY_COMPONENTS },
        { name: 'zeroForOne', type: 'bool' },
        { name: 'exactAmount', type: 'uint128' },
        { name: 'hookData', type: 'bytes' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
  },
] as const;

export const UNIVERSAL_ROUTER_ABI = [
  {
    name: 'execute', type: 'function', stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export const PERMIT2_ABI = [
  {
    name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  },
  {
    name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }],
    outputs: [],
  },
] as const;

const EXACT_INPUT_SINGLE_COMPONENTS = [
  { name: 'poolKey', type: 'tuple', components: V4_POOL_KEY_COMPONENTS },
  { name: 'zeroForOne', type: 'bool' },
  { name: 'amountIn', type: 'uint128' },
  { name: 'amountOutMinimum', type: 'uint128' },
  { name: 'hookData', type: 'bytes' },
] as const;

export function encodeV4ExactInputSingle(args: {
  poolKey: V4PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  currencyIn: Address;
  currencyOut: Address;
  deadline: bigint;
}): Hex {
  const swap = encodeAbiParameters(
    [{ type: 'tuple', components: EXACT_INPUT_SINGLE_COMPONENTS }],
    [{
      poolKey: args.poolKey,
      zeroForOne: args.zeroForOne,
      amountIn: args.amountIn,
      amountOutMinimum: args.amountOutMinimum,
      hookData: '0x',
    }],
  );
  const takeAll = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [args.currencyOut, args.amountOutMinimum],
  );
  const settleAll = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [args.currencyIn, args.amountIn],
  );
  const v4Input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    ['0x060f0c', [swap, takeAll, settleAll]],
  );
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: ['0x10', [v4Input], args.deadline],
  });
}

// Kept here so the encoder can be unit-tested without importing the live bot.
export function decodeV4Plan(data: Hex) {
  const decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data });
  const [actions, params] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    decoded.args?.[1][0] as Hex,
  );
  return { commands: decoded.args?.[0], actions, params, deadline: decoded.args?.[2] };
}
