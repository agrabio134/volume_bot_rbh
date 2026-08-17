import {
  createPublicClient,
  createWalletClient,
  parseUnits,
  formatUnits,
  encodeFunctionData,
  maxUint256,
  isAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import TelegramBot, { type Message } from 'node-telegram-bot-api';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import {
  robinhood, HUH_TOKEN, WETH_TOKEN, HUH_WETH_POOL, POOL_FEE, SWAP_ROUTER,
  QUOTER_V2, COMMISSION_WALLET, CONTROLLER_WALLET, getRpcTransport,
} from './chain';
import {
  PlatformStateStore, SlidingWindowRateLimiter, decryptWalletKeys, defaultUserPreference,
  encryptWalletKeys, makeId, type PaymentOrder, type PersistedSession,
} from './platform-state';

dotenv.config();

const MAIN_WALLET = CONTROLLER_WALLET;
const SUPER_ADMIN_KEY = '04012020';
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);

const DATA_FOLDER = process.env.DATA_DIR || process.cwd();
const PRIVATE_FOLDER = path.join(DATA_FOLDER, 'private_folder');
const ARCHIVE_FOLDER = path.join(DATA_FOLDER, 'archive_folder');
const platformStore = new PlatformStateStore(DATA_FOLDER);
const platform = platformStore.get();
const rateLimiter = new SlidingWindowRateLimiter();

fs.mkdirSync(PRIVATE_FOLDER, { recursive: true });
fs.mkdirSync(ARCHIVE_FOLDER, { recursive: true });

const bot = new TelegramBot(process.env.BOT_TOKEN!, { polling: true });
const publicClient = createPublicClient({
  chain: robinhood,
  transport: getRpcTransport(),
});

// Telegram can reject a single outgoing message (for example, malformed
// formatting). That reply must not terminate the long-running worker.
process.on('unhandledRejection', reason => {
  const telegramError = reason as { code?: string; message?: string };
  if (telegramError?.code === 'ETELEGRAM') {
    console.error(`[Telegram API error] ${telegramError.message || String(reason)}`);
    return;
  }
  setImmediate(() => {
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
});

type BotMode = 'volume' | 'bump';

type ActiveSession = PersistedSession;

const userStates = new Map<number, any>();
const activeBots = new Map<number, ActiveSession>(
  Object.entries(platform.sessions)
    .filter(([, session]) => session.setupStatus === 'funding' || (session.running && session.endTime > Date.now()))
    .map(([chatId, session]) => [Number(chatId), session]),
);

function savePlatformState(): void {
  platform.sessions = Object.fromEntries(Array.from(activeBots.entries()).map(([chatId, session]) => [String(chatId), session]));
  platformStore.save();
}

function currentUser(chatId: number) {
  const key = String(chatId);
  platform.users[key] ??= defaultUserPreference();
  return platform.users[key];
}

function orderById(orderId?: string): PaymentOrder | undefined {
  return orderId ? platform.orders.find(order => order.id === orderId) : undefined;
}

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals', type: 'function', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'name', type: 'function', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', inputs: [], outputs: [{ type: 'string' }] },
] as const;

const ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'recipient', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ]}],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    name: 'unwrapWETH9',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{ name: 'amountMinimum', type: 'uint256' }, { name: 'recipient', type: 'address' }],
    outputs: [],
  },
  {
    name: 'multicall', type: 'function', stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }], outputs: [{ name: 'results', type: 'bytes[]' }],
  },
] as const;

const QUOTER_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' }, { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' }],
}] as const;

const POOL_READ_ABI = [
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'fee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
] as const;

type PoolDiscovery = { poolAddress: `0x${string}`; poolFee: number; liquidityUsd?: number; dexUrl?: string; roundTripBps?: number };

async function discoverPool(tokenCA: string): Promise<PoolDiscovery> {
  const normalizedToken = tokenCA.toLowerCase();
  const pairsResponse = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${tokenCA}`, {
    signal: AbortSignal.timeout(6_000),
  });
  if (!pairsResponse.ok) throw new Error(`DEX Screener returned HTTP ${pairsResponse.status}`);
  const pairs = await pairsResponse.json() as Array<{
    pairAddress?: string;
    baseToken?: { address?: string };
    quoteToken?: { address?: string };
    liquidity?: { usd?: number };
    url?: string;
  }>;
  const candidates = pairs
    .filter(pair => pair.pairAddress && isAddress(pair.pairAddress))
    .filter(pair => {
      const addresses = [pair.baseToken?.address?.toLowerCase(), pair.quoteToken?.address?.toLowerCase()];
      return addresses.includes(normalizedToken) && addresses.includes(WETH_TOKEN.toLowerCase());
    })
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  if (!candidates.length) throw new Error('No WETH pool was found for this token on Robinhood Chain');

  for (const candidate of candidates) {
    try {
      const poolAddress = candidate.pairAddress as `0x${string}`;
      const [token0, token1, fee] = await Promise.all([
        publicClient.readContract({ address: poolAddress, abi: POOL_READ_ABI, functionName: 'token0' }),
        publicClient.readContract({ address: poolAddress, abi: POOL_READ_ABI, functionName: 'token1' }),
        publicClient.readContract({ address: poolAddress, abi: POOL_READ_ABI, functionName: 'fee' }),
      ]);
      const actualTokens = [token0.toLowerCase(), token1.toLowerCase()];
      if (!actualTokens.includes(normalizedToken) || !actualTokens.includes(WETH_TOKEN.toLowerCase())) continue;
      return { poolAddress, poolFee: Number(fee), liquidityUsd: candidate.liquidity?.usd, dexUrl: candidate.url };
    } catch {
      continue;
    }
  }
  throw new Error('The discovered pair is not a compatible Uniswap V3 WETH pool');
}

async function validateTokenAndPool(tokenCA: string): Promise<PoolDiscovery> {
  const bytecode = await publicClient.getBytecode({ address: tokenCA as `0x${string}` });
  if (!bytecode || bytecode === '0x') throw new Error('That address is not a token contract');
  const pool = tokenCA.toLowerCase() === HUH_TOKEN.toLowerCase()
    ? { poolAddress: HUH_WETH_POOL, poolFee: POOL_FEE }
    : await discoverPool(tokenCA);
  const minimumLiquidityUsd = Number(process.env.MIN_POOL_LIQUIDITY_USD || '1000');
  if (pool.liquidityUsd !== undefined && pool.liquidityUsd < minimumLiquidityUsd) {
    throw new Error(`Pool liquidity is below the $${minimumLiquidityUsd.toLocaleString()} safety minimum`);
  }
  const sampleIn = parseUnits(process.env.SAFETY_QUOTE_ETH || '0.0001', 18);
  const tokenOut = await quoteRaw(WETH_TOKEN, tokenCA as `0x${string}`, sampleIn, pool.poolFee);
  if (tokenOut <= 0n) throw new Error('Buy quote returned zero');
  const wethBack = await quoteRaw(tokenCA as `0x${string}`, WETH_TOKEN, tokenOut, pool.poolFee);
  const roundTripBps = Number((wethBack * 10_000n) / sampleIn);
  const minimumRoundTripBps = Number(process.env.MIN_ROUND_TRIP_BPS || '5000');
  if (roundTripBps < minimumRoundTripBps) {
    throw new Error(`Round-trip quote retained only ${(roundTripBps / 100).toFixed(2)}%; trading blocked`);
  }
  return { ...pool, roundTripBps };
}

async function quoteRaw(tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint, fee: number): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    address: QUOTER_V2, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

async function quoteMinimum(tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint, fee: number) {
  const quoted = await quoteRaw(tokenIn, tokenOut, amountIn, fee);
  const slippageBps = BigInt(Math.max(1, Math.min(1_500, Number(process.env.MAX_SLIPPAGE_BPS || '300'))));
  return (quoted * (10_000n - slippageBps)) / 10_000n;
}

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const jitter = (base: number, variance: number) => base + Math.random() * variance;

async function getTokenInfo(tokenCA: string) {
  try {
    const addr = tokenCA as `0x${string}`;
    const [name, symbol, decimals] = await Promise.all([
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'name' }).catch(() => 'Unknown'),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '???'),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
    ]);
    return { name: name as string, symbol: symbol as string, decimals: decimals as number };
  } catch {
    return { name: 'Unknown Token', symbol: '???', decimals: 18 };
  }
}

async function executeSwap(walletPk: string, session: ActiveSession, isBuy: boolean): Promise<bigint> {
  const { tokenCA, durationMs, mode } = session;
  const account = privateKeyToAccount(walletPk as `0x${string}`);
  const walletClient = createWalletClient({ chain: robinhood, transport: getRpcTransport(), account });
  const tokenInfo = await getTokenInfo(tokenCA);
  const router = SWAP_ROUTER;

  const nativeBalance = await publicClient.getBalance({ address: account.address });
  const maximumGasGwei = Number(process.env.MAX_GAS_PRICE_GWEI || '0');
  if (maximumGasGwei > 0) {
    const gasPrice = await publicClient.getGasPrice();
    if (gasPrice > parseUnits(String(maximumGasGwei), 9)) throw new Error('Gas price is above the configured safety limit');
  }

  if (isBuy) {
    // Scale each trade to the wallet balance so every package uses safe, proportional sizing.
    const baseBps = [350, 450, 550, 650][Math.floor(Math.random() * 4)];
    const aggression = Math.min(3.2, 3600000 * 3.0 / durationMs);
    const tradeBps = BigInt(Math.floor(baseBps * aggression));
    const rawAmountIn = (nativeBalance * tradeBps) / 10000n;

    if (!session.dailyWindowStartedAt || Date.now() - session.dailyWindowStartedAt >= 24 * 60 * 60 * 1000) {
      session.dailyWindowStartedAt = Date.now();
      session.dailyBuyWei = '0';
    }
    const dailyLimit = parseUnits(process.env.MAX_SESSION_DAILY_BUY_ETH || '0', 18);
    const spentToday = BigInt(session.dailyBuyWei || '0');
    if (dailyLimit > 0n && spentToday + rawAmountIn > dailyLimit) throw new Error('Session daily buy limit reached');

    if (nativeBalance < rawAmountIn + parseUnits('0.00002', 18)) throw new Error('Insufficient ETH for buy and gas');

    const amountOutMinimum = await quoteMinimum(WETH_TOKEN, tokenCA as `0x${string}`, rawAmountIn, session.poolFee || POOL_FEE);

    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{ tokenIn: WETH_TOKEN, tokenOut: tokenCA as `0x${string}`, fee: session.poolFee || POOL_FEE, recipient: account.address, amountIn: rawAmountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
    });

    const txHash = await walletClient.sendTransaction({ 
      to: router, data, value: rawAmountIn, gas: 950000n 
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    session.dailyBuyWei = (spentToday + rawAmountIn).toString();
    return rawAmountIn;
  } else {
    let tokenBalance = 0n;
    for (let i = 0; i < 12; i++) {
      await sleep(650);
      tokenBalance = await publicClient.readContract({ 
        address: tokenCA as `0x${string}`, 
        abi: ERC20_ABI, 
        functionName: 'balanceOf', 
        args: [account.address] 
      }) as bigint;
      if (tokenBalance > parseUnits('15', tokenInfo.decimals)) break;
    }
    if (tokenBalance < parseUnits('15', tokenInfo.decimals)) throw new Error('No sufficient tokens to sell');

    // Bump mode varies the recycle amount more; volume mode preserves its original stronger sell.
    const sellPercentage = mode === 'bump'
      ? 9000n + BigInt(Math.floor(Math.random() * 700)) // 90% to 97%
      : 9700n + BigInt(Math.floor(Math.random() * 200)); // 97% to 99%
    const rawAmountIn = (tokenBalance * sellPercentage) / 10000n;

    const allowance = await publicClient.readContract({ 
      address: tokenCA as `0x${string}`, 
      abi: ERC20_ABI, 
      functionName: 'allowance', 
      args: [account.address, router] 
    }) as bigint;

    if (allowance < rawAmountIn) {
      const approveTx = await walletClient.writeContract({
        address: tokenCA as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [router, maxUint256],
        gas: 170000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, confirmations: 1 });
      await sleep(1350);
    }

    const amountOutMinimum = await quoteMinimum(tokenCA as `0x${string}`, WETH_TOKEN, rawAmountIn, session.poolFee || POOL_FEE);
    const swapData = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{ tokenIn: tokenCA as `0x${string}`, tokenOut: WETH_TOKEN, fee: session.poolFee || POOL_FEE, recipient: router, amountIn: rawAmountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
    });
    const unwrapData = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'unwrapWETH9', args: [amountOutMinimum, account.address] });
    const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [[swapData, unwrapData]] });

    const txHash = await walletClient.sendTransaction({ 
      to: router, data, value: 0n, gas: 950000n 
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    return 0n;
  }
}

function chooseBuyCount(): number {
  const roll = Math.random();
  if (roll < 0.25) return 1;
  if (roll < 0.85) return 2;
  return 3;
}

async function startVolume(chatId: number, resumed = false): Promise<void> {
  const session = activeBots.get(chatId)!;
  const endTime = session.endTime || (session.startTime + session.durationMs);
  session.endTime = endTime;
  const tokenInfo = await getTokenInfo(session.tokenCA);
  const modeLabel = session.mode === 'bump' ? 'Random Bump Mode' : 'Volume Mode';
  const ratioLabel = 'Random 1:1 / 2:1 / 3:1 (2:1 most common)';

  bot.sendMessage(chatId, `${resumed ? '♻️ *Session Resumed After Restart*' : '🚀 *Bot Started*'}\n\n⚙️ Mode: ${modeLabel}\n📛 Token: ${tokenInfo.name} (${tokenInfo.symbol})\n🔗 CA: \`${session.tokenCA}\`\n💎 Package: ${session.package}\n⚖️ Ratio: ${ratioLabel}\n⏱ Remaining: ${Math.max(0, Math.ceil((endTime - Date.now()) / 60000))} min\n👥 Wallets: ${session.wallets.length}`, { parse_mode: 'Markdown' }).catch(() => {});
  savePlatformState();

  // Dynamic base delay based on total duration
  const baseCycleDelay = Math.max(4500, Math.floor(session.durationMs / 180)); // Longer duration = slower cycles

  while (session.running && Date.now() < endTime) {
    if (session.paused) { await sleep(5000); continue; }

    for (const w of session.wallets) {
      if (!session.running || Date.now() > endTime) break;
      if (session.paused) { await sleep(1200); continue; }

      try {
        const buyCount = chooseBuyCount();
        for (let i = 0; i < buyCount; i++) {
          await executeSwap(w.privateKey, session, true);
          session.completedBuys++;
          session.lastActivityAt = Date.now();
          savePlatformState();
          await sleep(session.mode === 'bump' ? jitter(2400, 4800) : jitter(1350, 1850));
        }
        await executeSwap(w.privateKey, session, false);
        session.completedSells++;
        session.lastActivityAt = Date.now();
        savePlatformState();
        await sleep(session.mode === 'bump' ? jitter(3800, 6200) : jitter(2100, 2800));
      } catch (e: any) {
        session.failedSwaps++;
        session.lastActivityAt = Date.now();
        const reason = e?.message || String(e);
        if (/Insufficient ETH|daily buy limit/i.test(reason)) {
          session.running = false;
          bot.sendMessage(chatId, `🛑 Session stopped by a safety rule: ${reason}`).catch(() => {});
        }
        savePlatformState();
        log(`Swap error chatId ${chatId}: ${reason}`, 'ERROR');
        await sleep(10000);
      }
    }

    // Duration-aware pause between full wallet cycles
    const cyclePause = jitter(baseCycleDelay, baseCycleDelay * (session.mode === 'bump' ? 1.2 : 0.6));
    await sleep(Math.min(cyclePause, session.mode === 'bump' ? 45000 : 25000));
  }

  session.running = false;
  const completedOrder = orderById(session.orderId);
  if (completedOrder) {
    completedOrder.status = 'completed';
    completedOrder.completedAt = Date.now();
  }
  activeBots.delete(chatId);
  savePlatformState();
  bot.sendMessage(chatId, '🛑 Volume bot finished.').catch(() => {});
}

function generateWallets(count: number) {
  const wallets: { privateKey: string }[] = [];
  for (let i = 0; i < count; i++) {
    const privateKey = '0x' + crypto.randomBytes(32).toString('hex');
    wallets.push({ privateKey });
  }
  return wallets;
}

function getWalletCount(packageType: string, mode: BotMode): number {
  const volumeCounts: Record<string, number> = {
    test: 2,
    starter: 3,
    dolphin: 4,
    whale: 6,
    max: 8,
  };
  const bumpCounts: Record<string, number> = {
    test: 3,
    starter: 3,
    dolphin: 4,
    whale: 5,
    max: 5,
  };
  return (mode === 'bump' ? bumpCounts : volumeCounts)[packageType] ?? (mode === 'bump' ? 3 : 10);
}

function saveWalletsToFile(chatId: number, tokenCA: string, wallets: { privateKey: string }[]) {
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${date}_${chatId}_${tokenCA.slice(0, 10)}.wallets.enc`;
  const filePath = path.join(PRIVATE_FOLDER, filename);
  fs.writeFileSync(filePath, encryptWalletKeys(wallets.map(w => w.privateKey)), { mode: 0o600 });
  log(`Wallets saved to ${filePath}`);
}

async function fundWallets(wallets: { privateKey: string }[], amountPerWallet: string): Promise<void> {
  if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY is not configured');
  const mainAcc = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const wc = createWalletClient({ chain: robinhood, transport: getRpcTransport(), account: mainAcc });
  const target = parseUnits(amountPerWallet, 18);
  const failures: string[] = [];
  for (const w of wallets) {
    try {
      const acc = privateKeyToAccount(w.privateKey as `0x${string}`);
      const existing = await publicClient.getBalance({ address: acc.address });
      if (existing < target) {
        const txHash = await wc.sendTransaction({ to: acc.address, value: target - existing, gas: 50000n });
        await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
      }
    } catch (e: any) {
      failures.push(e?.message || String(e));
      log(`Funding failed for wallet: ${e}`, 'WARN');
    }
    await sleep(480);
  }
  if (failures.length) throw new Error(`Funding incomplete for ${failures.length} wallet(s)`);
}

async function findPaymentTransaction(order: PaymentOrder): Promise<string | undefined> {
  const latest = await publicClient.getBlockNumber();
  const created = BigInt(order.createdBlock);
  let cursor = order.lastScannedBlock ? BigInt(order.lastScannedBlock) + 1n : created;
  if (cursor > latest) return undefined;
  // Bound each poll to avoid overwhelming the RPC during busy periods.
  const end = cursor + 24n < latest ? cursor + 24n : latest;
  const expected = BigInt(order.expectedWei);
  const claimed = new Set(platform.claimedPaymentTxHashes.map(hash => hash.toLowerCase()));

  for (; cursor <= end; cursor++) {
    const block = await publicClient.getBlock({ blockNumber: cursor, includeTransactions: true });
    for (const transaction of block.transactions) {
      if (typeof transaction === 'string') continue;
      if (!transaction.to || transaction.to.toLowerCase() !== MAIN_WALLET.toLowerCase()) continue;
      if (transaction.value < expected || claimed.has(transaction.hash.toLowerCase())) continue;
      const receipt = await publicClient.getTransactionReceipt({ hash: transaction.hash });
      if (receipt.status === 'success') {
        order.lastScannedBlock = cursor.toString();
        savePlatformState();
        return transaction.hash;
      }
    }
    order.lastScannedBlock = cursor.toString();
  }
  savePlatformState();
  return undefined;
}

async function completeFundingSession(chatId: number, session: ActiveSession): Promise<void> {
  const order = orderById(session.orderId);
  if (!order) throw new Error('Session order was not found');
  if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY is not configured');
  if (!order.commissionTxHash) {
    const mainAcc = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
    const wc = createWalletClient({ chain: robinhood, transport: getRpcTransport(), account: mainAcc });
    const commission = (BigInt(order.expectedWei) * 20n) / 100n;
    const commissionHash = await wc.sendTransaction({ to: COMMISSION_WALLET, value: commission, gas: 50000n });
    await publicClient.waitForTransactionReceipt({ hash: commissionHash, confirmations: 1 });
    order.commissionTxHash = commissionHash;
    savePlatformState();
  }
  await fundWallets(session.wallets, formatUnits(BigInt(session.fundingTargetWei || '0'), 18));
  session.setupStatus = 'ready';
  session.running = true;
  session.startTime = Date.now();
  session.endTime = session.startTime + session.durationMs;
  session.lastActivityAt = Date.now();
  order.status = 'running';
  delete order.failureReason;
  savePlatformState();
}

async function handlePayment(chatId: number, expectedAmount: string, state: any): Promise<void> {
  const expected = parseUnits(expectedAmount, 18);
  const order = orderById(state.orderId);
  if (!order) {
    userStates.delete(chatId);
    await bot.sendMessage(chatId, '❌ Payment invoice was not found. Start again with /start.');
    return;
  }
  order.status = 'verifying';
  savePlatformState();
  bot.sendMessage(chatId, `⏳ Verifying *${expectedAmount} ETH* on \`${MAIN_WALLET}\``, { parse_mode: 'Markdown' });
  for (let i = 0; i < 72; i++) {
    if (i > 0) await sleep(5000);
    try {
      const paymentTxHash = await findPaymentTransaction(order);
      if (paymentTxHash) {
        // Claim this order before any awaited setup work so no second PAID
        // message or verifier can confirm the same payment again.
        order.status = 'paid';
        order.paymentTxHash = paymentTxHash;
        platform.claimedPaymentTxHashes.push(paymentTxHash);
        savePlatformState();
        userStates.delete(chatId);
        await bot.sendMessage(chatId, `✅ Payment confirmed!\nReceipt: \`${order.id}\`\nPreparing wallets…`, { parse_mode: 'Markdown' });

        try {
          const mode: BotMode = state.mode === 'bump' ? 'bump' : 'volume';
          const walletCount = getWalletCount(state.package, mode);
          const sessionWallets = generateWallets(walletCount);
          saveWalletsToFile(chatId, state.tokenCA, sessionWallets);

          const usable = (expected * 80n) / 100n;
          const perWallet = usable / BigInt(walletCount);
          const session: ActiveSession = {
            tokenCA: state.tokenCA,
            running: false,
            paused: false,
            package: state.package,
            mode,
            durationMs: state.durationMs,
            wallets: sessionWallets,
            startTime: Date.now(),
            endTime: Date.now() + state.durationMs,
            orderId: order.id,
            poolAddress: state.poolAddress,
            poolFee: state.poolFee,
            completedBuys: 0,
            completedSells: 0,
            failedSwaps: 0,
            lastActivityAt: Date.now(),
            setupStatus: 'funding',
            fundingTargetWei: perWallet.toString(),
          };
          activeBots.set(chatId, session);
          savePlatformState();
          await completeFundingSession(chatId, session);
          void startVolume(chatId);
        } catch (error: any) {
          order.status = activeBots.get(chatId)?.setupStatus === 'funding' ? 'paid' : 'failed';
          order.failureReason = error?.message || String(error);
          savePlatformState();
          log(`Paid order setup failed for chatId ${chatId}: ${error?.message || error}`, 'ERROR');
          await bot.sendMessage(chatId, '❌ Payment was confirmed, but wallet setup failed. Contact the administrator; the payment will not be charged twice.');
        }
        return;
      }
    } catch (error: any) {
      log(`Payment verification error for chatId ${chatId}: ${error?.message || error}`, 'WARN');
    }
  }
  userStates.delete(chatId);
  order.status = 'expired';
  savePlatformState();
  bot.sendMessage(chatId, '❌ Payment not detected.');
}

// === Admin & Other Functions (unchanged) ===
async function refundAllWallets(chatId: number): Promise<void> {
  const session = activeBots.get(chatId);
  if (!session) {
    await bot.sendMessage(chatId, '❌ No active session.');
    return;
  }
  session.running = false;
  for (const w of session.wallets) {
    try {
      const acc = privateKeyToAccount(w.privateKey as `0x${string}`);
      const wc2 = createWalletClient({ chain: robinhood, transport: getRpcTransport(), account: acc });
      const balance = await publicClient.getBalance({ address: acc.address });
      if (balance > parseUnits('0.00001', 18)) {
        await wc2.sendTransaction({ to: MAIN_WALLET, value: balance - parseUnits('0.00001', 18), gas: 50000n });
      }
    } catch {}
    await sleep(650);
  }
  activeBots.delete(chatId);
  bot.sendMessage(chatId, '✅ Session refund completed.');
}

async function getAllPrivateKeysFromFolder(): Promise<string[]> {
  const files = fs.readdirSync(PRIVATE_FOLDER).filter(f => f.endsWith('.txt') || f.endsWith('.wallets.enc'));
  const allKeys: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(PRIVATE_FOLDER, file), 'utf8');
    const keys = file.endsWith('.wallets.enc')
      ? decryptWalletKeys(content)
      : content.split('\n').map(l => l.trim()).filter(l => l && l.startsWith('0x'));
    allKeys.push(...keys);
  }
  return allKeys;
}

async function moveToArchive(): Promise<void> {
  const files = fs.readdirSync(PRIVATE_FOLDER).filter(f => f.endsWith('.txt') || f.endsWith('.wallets.enc'));
  for (const file of files) {
    fs.renameSync(path.join(PRIVATE_FOLDER, file), path.join(ARCHIVE_FOLDER, file));
  }
  log(`Moved ${files.length} files to archive_folder`);
}

async function refundAllAdmin(chatId: number, key: string): Promise<void> {
  if (chatId !== ADMIN_CHAT_ID && key !== SUPER_ADMIN_KEY) {
    bot.sendMessage(chatId, '❌ Unauthorized.');
    return;
  }
  const allKeys = await getAllPrivateKeysFromFolder();
  if (allKeys.length === 0) {
    bot.sendMessage(chatId, '❌ No wallets found in private_folder.');
    return;
  }

  bot.sendMessage(chatId, `🔄 Starting refund of ${allKeys.length} wallets...`);
  let success = 0;
  let totalRefunded = 0n;

  for (const pk of allKeys) {
    try {
      const account = privateKeyToAccount(pk as `0x${string}`);
      const wc = createWalletClient({ chain: robinhood, transport: getRpcTransport(), account });
      const balance = await publicClient.getBalance({ address: account.address });
      if (balance > parseUnits('0.00001', 18)) {
        const sendAmount = balance - parseUnits('0.00001', 18);
        const txHash = await wc.sendTransaction({ to: MAIN_WALLET, value: sendAmount, gas: 50000n });
        await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
        totalRefunded += sendAmount;
        success++;
      }
      await sleep(850);
    } catch (e) {
      log(`Refund failed for key segment: ${pk.slice(0,10)}...`, 'ERROR');
    }
  }

  await moveToArchive();
  bot.sendMessage(chatId, `✅ Refund completed!\nWallets processed: ${success}\nTotal ETH refunded: ${formatUnits(totalRefunded, 18)}\nFiles moved to archive_folder.`);
}

async function consolidateAllAdmin(chatId: number, key: string): Promise<void> {
  if (!Number.isSafeInteger(ADMIN_CHAT_ID) || chatId !== ADMIN_CHAT_ID) {
    bot.sendMessage(chatId, '❌ Unauthorized.');
    return;
  }
  if (Array.from(activeBots.values()).some(session => session.running)) {
    bot.sendMessage(chatId, '❌ Consolidation blocked: a volume session is still running. Stop or wait for all sessions to finish first.');
    return;
  }
  const allKeys = await getAllPrivateKeysFromFolder();
  if (allKeys.length === 0) {
    bot.sendMessage(chatId, '❌ No wallets found.');
    return;
  }

  bot.sendMessage(chatId, `🔄 Starting consolidation of ${allKeys.length} wallets...`);
  let success = 0;
  let failed = 0;
  let totalSent = 0n;

  for (const pk of allKeys) {
    try {
      const account = privateKeyToAccount(pk as `0x${string}`);
      const wc = createWalletClient({ chain: robinhood, transport: getRpcTransport(), account });
      const balance = await publicClient.getBalance({ address: account.address });
      if (balance < parseUnits("0.00003", 18)) {
        await sleep(650);
        continue;
      }
      const sendAmount = balance - parseUnits("0.00002", 18);
      const txHash = await wc.sendTransaction({
        to: COMMISSION_WALLET,
        value: sendAmount,
        gas: 65000n
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
      totalSent += sendAmount;
      success++;
      await sleep(1250);
    } catch (e) {
      log(`Consolidation failed for key: ${pk.slice(0,10)}...`, 'ERROR');
      failed++;
    }
  }

  if (failed === 0) {
    await moveToArchive();
  }
  bot.sendMessage(chatId, `🎉 Consolidation finished!\n✅ Success: ${success}\n❌ Failed: ${failed}\n💰 Total ETH: ${formatUnits(totalSent, 18)}\n📁 Files ${failed === 0 ? 'archived' : 'kept for retry'}.`);
}

function isSuperAdminMessage(msg: Message): boolean {
  if (!Number.isSafeInteger(ADMIN_CHAT_ID)) return false;
  return msg.chat.id === ADMIN_CHAT_ID || msg.from?.id === ADMIN_CHAT_ID;
}

function referralCode(chatId: number): string {
  return `RBH${Math.abs(chatId).toString(36).toUpperCase()}`;
}

function discountBps(chatId: number): number {
  const preference = currentUser(chatId);
  if (preference.promoCode === 'WELCOME5' || preference.referredBy) return 500;
  return 0;
}

function sessionLine(session: ActiveSession): string {
  const remaining = Math.max(0, Math.ceil((session.endTime - Date.now()) / 60_000));
  return `${session.mode.toUpperCase()} | ${session.package} | ${remaining}m left | ${session.completedBuys} buys | ${session.completedSells} sells | ${session.failedSwaps} errors`;
}

async function sendHealth(chatId: number): Promise<void> {
  try {
    const started = Date.now();
    const block = await publicClient.getBlockNumber();
    const latency = Date.now() - started;
    const running = Array.from(activeBots.values()).filter(session => session.running).length;
    const lastActivity = Math.max(0, ...Array.from(activeBots.values()).map(session => session.lastActivityAt || 0));
    await bot.sendMessage(chatId, [
      '🩺 Bot Health',
      `RPC: ONLINE (${latency}ms)`,
      `Latest block: ${block}`,
      `Active sessions: ${running}`,
      `Open payments: ${platform.orders.filter(order => ['pending', 'verifying'].includes(order.status)).length}`,
      `Last trading activity: ${lastActivity ? new Date(lastActivity).toISOString() : 'none'}`,
      `Persistent storage: encrypted v${platform.version}`,
    ].join('\n'));
  } catch (error: any) {
    await bot.sendMessage(chatId, `⚠️ Health degraded\nRPC: OFFLINE\n${error?.message || error}`);
  }
}

// ==================== COMMANDS ====================

bot.onText(/\/start/, (msg) => {
  if (!rateLimiter.allow(msg.from?.id || msg.chat.id)) return void bot.sendMessage(msg.chat.id, 'Please wait a moment before sending more commands.');
  const preference = currentUser(msg.chat.id);
  savePlatformState();
  bot.sendMessage(msg.chat.id, preference.language === 'fil' ? '🚀 *Robinhood Chain Trading Bot*\n\nPumili ng mode:' : '🚀 *Robinhood Chain Trading Bot*\n\nChoose a mode:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: preference.language === 'fil' ? '🚀 Simulan ang Volume' : '🚀 Start Volume Boost', callback_data: 'start_boost' }],
      [{ text: preference.language === 'fil' ? '📈 Simulan ang Bump Mode' : '📈 Start Random Bump Mode', callback_data: 'start_bump' }],
    ] },
  });
});

bot.onText(/^\/dashboard(?:@\w+)?$/, (msg) => {
  const sessions = Array.from(activeBots.values()).filter(session => session.running);
  const orders = platform.orders.filter(order => order.chatId === msg.chat.id);
  const latest = orders.slice(-3).reverse();
  const lines = [
    '📋 YOUR DASHBOARD',
    `Active sessions: ${sessions.filter(session => orderById(session.orderId)?.chatId === msg.chat.id).length}`,
    `Orders: ${orders.length}`,
    `Referral code: ${referralCode(msg.chat.id)}`,
    '',
    ...latest.map(order => `${order.id} | ${order.package} | ${order.status}`),
  ];
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});

bot.onText(/^\/history(?:@\w+)?$/, (msg) => {
  const orders = platform.orders.filter(order => order.chatId === msg.chat.id).slice(-10).reverse();
  if (!orders.length) return void bot.sendMessage(msg.chat.id, 'No orders yet.');
  bot.sendMessage(msg.chat.id, `🧾 Order History\n\n${orders.map(order => `${order.id}\n${order.package} • ${order.mode} • ${order.status}\n${formatUnits(BigInt(order.expectedWei), 18)} ETH`).join('\n\n')}`);
});

bot.onText(/^\/receipt(?:@\w+)?\s+(\S+)$/, (msg, match) => {
  const order = platform.orders.find(item => item.id === match?.[1] && (item.chatId === msg.chat.id || isSuperAdminMessage(msg)));
  if (!order) return void bot.sendMessage(msg.chat.id, 'Receipt not found.');
  bot.sendMessage(msg.chat.id, [
    '🧾 PAYMENT RECEIPT',
    `Order: ${order.id}`,
    `Package: ${order.package}`,
    `Mode: ${order.mode}`,
    `Amount: ${formatUnits(BigInt(order.expectedWei), 18)} ETH`,
    `Status: ${order.status}`,
    `Payment tx: ${order.paymentTxHash || 'pending'}`,
    `Created: ${new Date(order.createdAt).toISOString()}`,
  ].join('\n'));
});

bot.onText(/^\/health(?:@\w+)?$/, msg => void sendHealth(msg.chat.id));

bot.onText(/^\/demo(?:@\w+)?(?:\s+(0x[a-fA-F0-9]{40}))?$/, async (msg, match) => {
  const tokenCA = match?.[1] || HUH_TOKEN;
  try {
    const [info, pool] = await Promise.all([getTokenInfo(tokenCA), validateTokenAndPool(tokenCA)]);
    const sampleIn = parseUnits('0.001', 18);
    const quoted = await quoteMinimum(WETH_TOKEN, tokenCA as `0x${string}`, sampleIn, pool.poolFee);
    await bot.sendMessage(msg.chat.id, [
      '🧪 DEMO QUOTE — no funds moved',
      `${info.name} (${info.symbol})`,
      `Input: 0.001 ETH`,
      `Estimated minimum output: ${formatUnits(quoted, info.decimals)} ${info.symbol}`,
      `Pool fee: ${pool.poolFee}`,
      `Liquidity: ${pool.liquidityUsd === undefined ? 'not supplied' : `$${pool.liquidityUsd.toLocaleString()}`}`,
      'Contract and WETH pool validation: PASSED',
    ].join('\n'));
  } catch (error: any) {
    await bot.sendMessage(msg.chat.id, `❌ Demo validation failed: ${error?.message || error}`);
  }
});

bot.onText(/^\/referral(?:@\w+)?$/, msg => {
  const user = currentUser(msg.chat.id);
  bot.sendMessage(msg.chat.id, `🎁 Your referral code: ${referralCode(msg.chat.id)}\nSuccessful uses: ${user.referralUses}\nNew users receive 5% off their next package.`);
});

bot.onText(/^\/promo(?:@\w+)?\s+(\S+)$/, (msg, match) => {
  const code = (match?.[1] || '').toUpperCase();
  const preference = currentUser(msg.chat.id);
  if (code === 'WELCOME5') {
    preference.promoCode = code;
  } else if (code.startsWith('RBH')) {
    const referrer = Object.keys(platform.users).map(Number).find(chatId => referralCode(chatId) === code && chatId !== msg.chat.id);
    if (!referrer) return void bot.sendMessage(msg.chat.id, 'Invalid referral code.');
    preference.referredBy = referrer;
    platform.users[String(referrer)].referralUses++;
  } else {
    return void bot.sendMessage(msg.chat.id, 'Invalid promo code.');
  }
  savePlatformState();
  bot.sendMessage(msg.chat.id, '✅ 5% discount saved for your next order.');
});

bot.onText(/^\/language(?:@\w+)?\s+(en|fil)$/i, (msg, match) => {
  const language = match?.[1]?.toLowerCase() as 'en' | 'fil';
  currentUser(msg.chat.id).language = language;
  savePlatformState();
  bot.sendMessage(msg.chat.id, language === 'fil' ? '✅ Filipino ang napiling wika.' : '✅ Language set to English.');
});

bot.onText(/^\/timezone(?:@\w+)?\s+(\S+)$/, (msg, match) => {
  const timezone = match?.[1] || '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    return void bot.sendMessage(msg.chat.id, 'Invalid timezone. Example: /timezone Asia/Manila');
  }
  currentUser(msg.chat.id).timezone = timezone;
  savePlatformState();
  bot.sendMessage(msg.chat.id, `✅ Timezone set to ${timezone}.`);
});

bot.onText(/^\/support(?:@\w+)?\s+([\s\S]{3,500})$/, (msg, match) => {
  const ticket = { id: makeId('ticket'), chatId: msg.chat.id, text: match?.[1] || '', createdAt: Date.now(), status: 'open' as const };
  platform.tickets.push(ticket);
  savePlatformState();
  bot.sendMessage(msg.chat.id, `🎫 Support ticket created: ${ticket.id}`);
  if (Number.isSafeInteger(ADMIN_CHAT_ID)) bot.sendMessage(ADMIN_CHAT_ID, `🎫 New ticket ${ticket.id}\nChat: ${msg.chat.id}\n${ticket.text}`).catch(() => {});
});

bot.onText(/^\/bump(?:@\w+)?$/, (msg) => {
  userStates.set(msg.chat.id, { step: 'ca', mode: 'bump' as BotMode });
  bot.sendMessage(msg.chat.id, '📈 *Random Bump Mode*\n\nUses 3–5 reusable wallets and random 1:1, 2:1 or 3:1 buy/sell cycles.\n\n🔗 Paste the token contract address (CA):', { parse_mode: 'Markdown' });
});

bot.onText(/\/myorders/, (msg) => {
  const chatId = msg.chat.id;
  const session = activeBots.get(chatId);
  if (!session) return bot.sendMessage(chatId, '📭 No active session. Use /start');
  const elapsed = Math.floor((Date.now() - session.startTime)/60000);
  bot.sendMessage(chatId, `📊 *Active Session*\nMode: ${session.mode === 'bump' ? 'Random Bump' : 'Volume'}\nToken: \`${session.tokenCA}\`\nPackage: ${session.package}\nWallets: ${session.wallets.length}\nDuration: ${Math.floor(session.durationMs/3600000)}h\nElapsed: ${elapsed} min\nBuys/Sells: ${session.completedBuys}/${session.completedSells}\nErrors: ${session.failedSwaps}\nOrder: \`${session.orderId}\`\nStatus: ${session.paused ? '⏸️ PAUSED' : '▶️ RUNNING'}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: session.paused ? '▶️ Resume' : '⏸️ Pause', callback_data: session.paused ? 'resume' : 'pause' }],
      [{ text: '🛑 Stop', callback_data: 'stop' }],
    ]},
  });
});

bot.onText(/\/status/, (msg) => {
  const session = activeBots.get(msg.chat.id);
  if (!session) return bot.sendMessage(msg.chat.id, 'No active volume.');
  bot.sendMessage(msg.chat.id, `🔍 Status:\n${sessionLine(session)}\nToken: ${session.tokenCA}\nWallets: ${session.wallets.length}\nRunning: ${session.running}\nPaused: ${session.paused}`);
});

bot.onText(/^\/status_admin(?:@\w+)?(?:\s+(\S+))?$/, async (msg, match) => {
  const providedKey = match?.[1];
  if (isSuperAdminMessage(msg) && (!providedKey || providedKey === SUPER_ADMIN_KEY)) {
    const sessions = Array.from(activeBots.entries());
    let text = `👑 *Admin Status*\nTotal Active Sessions: ${sessions.length}\n\n`;
    sessions.forEach(([id, s]) => {
      text += `Chat ${id}: ${s.tokenCA} | ${s.mode} | ${s.package} | ${s.wallets.length} wallets | ${s.running ? 'RUNNING' : 'STOPPED'}\n`;
    });
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(msg.chat.id, '❌ Invalid key.');
  }
});

bot.onText(/^\/analyticsadmin(?:@\w+)?$/, msg => {
  if (!isSuperAdminMessage(msg)) return void bot.sendMessage(msg.chat.id, '❌ Unauthorized.');
  const paid = platform.orders.filter(order => ['paid', 'running', 'completed'].includes(order.status));
  const gross = paid.reduce((sum, order) => sum + BigInt(order.expectedWei), 0n);
  bot.sendMessage(msg.chat.id, [
    '👑 ADMIN ANALYTICS',
    `Users: ${Object.keys(platform.users).length}`,
    `Orders: ${platform.orders.length}`,
    `Paid orders: ${paid.length}`,
    `Gross credited: ${formatUnits(gross, 18)} ETH`,
    `Running: ${Array.from(activeBots.values()).filter(session => session.running).length}`,
    `Open tickets: ${platform.tickets.filter(ticket => ticket.status === 'open').length}`,
    `Payment failures: ${platform.orders.filter(order => order.status === 'failed').length}`,
  ].join('\n'));
});

bot.onText(/^\/ticketsadmin(?:@\w+)?$/, msg => {
  if (!isSuperAdminMessage(msg)) return void bot.sendMessage(msg.chat.id, '❌ Unauthorized.');
  const open = platform.tickets.filter(ticket => ticket.status === 'open').slice(-10);
  bot.sendMessage(msg.chat.id, open.length
    ? `🎫 OPEN TICKETS\n\n${open.map(ticket => `${ticket.id} | chat ${ticket.chatId}\n${ticket.text}`).join('\n\n')}`
    : 'No open tickets.');
});

bot.onText(/^\/closeticket(?:@\w+)?\s+(\S+)$/, (msg, match) => {
  if (!isSuperAdminMessage(msg)) return void bot.sendMessage(msg.chat.id, '❌ Unauthorized.');
  const ticket = platform.tickets.find(item => item.id === match?.[1]);
  if (!ticket) return void bot.sendMessage(msg.chat.id, 'Ticket not found.');
  ticket.status = 'closed';
  savePlatformState();
  bot.sendMessage(msg.chat.id, `✅ Closed ${ticket.id}.`);
});

bot.onText(/^\/backupadmin(?:@\w+)?$/, msg => {
  if (!isSuperAdminMessage(msg)) return void bot.sendMessage(msg.chat.id, '❌ Unauthorized.');
  const backup = platformStore.exportBackup();
  bot.sendMessage(msg.chat.id, `✅ Encrypted backup created: ${path.basename(backup)}`);
});

bot.onText(/^\/stopalladmin(?:@\w+)?$/, msg => {
  if (!isSuperAdminMessage(msg)) return void bot.sendMessage(msg.chat.id, '❌ Unauthorized.');
  let stopped = 0;
  for (const session of activeBots.values()) {
    if (!session.running) continue;
    session.running = false;
    stopped++;
  }
  savePlatformState();
  bot.sendMessage(msg.chat.id, `🛑 Emergency stop activated. ${stopped} session(s) stopped.`);
});

bot.onText(/^\/refundalladmin(?:@\w+)?(?:\s+(\S+))?$/, (msg, match) => {
  const key = match?.[1];
  if (!isSuperAdminMessage(msg)) return void bot.sendMessage(msg.chat.id, '❌ Unauthorized.');
  refundAllAdmin(msg.chat.id, key || SUPER_ADMIN_KEY);
});

bot.onText(/^\/consolidateadmin(?:@\w+)?(?:\s+(\S+))?$/, (msg, match) => {
  const key = match?.[1];
  consolidateAllAdmin(msg.chat.id, key || '');
});

bot.onText(/\/active/, (msg) => {
  const session = activeBots.get(msg.chat.id);
  if (session) bot.sendMessage(msg.chat.id, `✅ You have 1 active bot running.`);
  else bot.sendMessage(msg.chat.id, `❌ No active bot.`);
});

bot.onText(/\/help/, (msg) => {
  if (currentUser(msg.chat.id).language === 'fil') {
    return void bot.sendMessage(msg.chat.id,
`📋 Mga Command

/start - Pumili ng mode
/myorders - Aktibong session
/dashboard - Mga order at referral
/history - Nakaraang order
/health - Kalagayan ng serbisyo
/demo [CA] - Ligtas na quote lamang
/support MENSAHE - Humingi ng tulong
/language en - Bumalik sa English`).catch(error => log(`Help reply failed: ${error.message}`, 'ERROR'));
  }
  bot.sendMessage(msg.chat.id, 
`📋 Available Commands

/start - Choose volume or bump mode
/bump - Start random bump mode
/myorders - View active session
/status - Check current status
/active - Check if you have running bot
/dashboard - Orders and referral overview
/history - Recent orders
/receipt ORDER_ID - Payment receipt
/health - Service and RPC health
/demo [CA] - Safe quote without moving funds
/referral - Get your referral code
/promo CODE - Apply a promo/referral code
/language en|fil - Choose language
/timezone Asia/Manila - Set timezone
/support MESSAGE - Contact support
/help - This message

To pause, resume or stop a session, use the buttons in /myorders.`)
    .catch(error => log(`Help reply failed: ${error.message}`, 'ERROR'));
});

function sendPackageMenu(chatId: number) {
  return bot.sendMessage(chatId, '💎 *Choose Package*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🧪 Test — 0.02 ETH', callback_data: 'pkg_test' }],
      [{ text: '🔥 Starter — 0.05 ETH', callback_data: 'pkg_starter' }],
      [{ text: '🐬 Dolphin — 0.15 ETH', callback_data: 'pkg_dolphin' }],
      [{ text: '🐋 Whale — 0.50 ETH', callback_data: 'pkg_whale' }],
      [{ text: '🌟 Max — 1.00 ETH', callback_data: 'pkg_max' }],
    ]},
  });
}

bot.on('callback_query', async (query) => {
  const chatId = query.message!.chat.id;
  const data = query.data || '';
  if (!rateLimiter.allow(query.from.id, 14, 10_000)) {
    return void bot.answerCallbackQuery(query.id, { text: 'Please slow down.', show_alert: true }).catch(() => {});
  }
  bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'start_boost') {
    userStates.set(chatId, { step: 'ca', mode: 'volume' as BotMode });
    bot.sendMessage(chatId, '🔗 Paste the token contract address (CA):');
  } else if (data === 'start_bump') {
    userStates.set(chatId, { step: 'ca', mode: 'bump' as BotMode });
    bot.sendMessage(chatId, '📈 *Random Bump Mode*\n\nUses 3–5 reusable wallets and random 1:1, 2:1 or 3:1 buy/sell cycles.\n\n🔗 Paste the token contract address (CA):', { parse_mode: 'Markdown' });
  } else if (data.startsWith('pkg_')) {
    const pkgMap: Record<string, string> = { 
      pkg_test: '0.02',
      pkg_starter: '0.05',
      pkg_dolphin: '0.15',
      pkg_whale: '0.50',
      pkg_max: '1.00',
    };
    const pkgType = data.replace('pkg_', '');
    const state = userStates.get(chatId);
    if (state) {
      if (!pkgMap[data]) return;
      state.expected = pkgMap[data];
      state.package = pkgType;
      state.step = 'duration';
      bot.sendMessage(chatId, '⏱ *Choose Duration*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '30 mins (Rapid)', callback_data: 'dur_30' }],
          [{ text: '1 hour (Turbo)', callback_data: 'dur_60' }],
          [{ text: '3 hours', callback_data: 'dur_180' }],
          [{ text: '6 hours', callback_data: 'dur_360' }],
          [{ text: '8 hours', callback_data: 'dur_480' }],
          [{ text: '12 hours', callback_data: 'dur_720' }],
          [{ text: '24 hours', callback_data: 'dur_1440' }],
          [{ text: '2 days', callback_data: 'dur_2880' }],
        ]},
      });
    }
  } else if (data.startsWith('dur_')) {
    const minutes = parseInt(data.replace('dur_', ''));
    const state = userStates.get(chatId);
    if (state) {
      state.durationMs = minutes * 60 * 1000;
      state.step = 'confirm';
      const selectedMode = state.mode === 'bump' ? 'Random Bump' : 'Volume';
      const walletCount = getWalletCount(state.package, state.mode === 'bump' ? 'bump' : 'volume');
      bot.sendMessage(chatId, `✅ Package and duration selected.\n\nMode: *${selectedMode}*\nWallets: *${walletCount}*\nRatio: *Random 1:1 / 2:1 / 3:1*\n\nReply *YES* to continue with \`${state.tokenCA}\`.`, { parse_mode: 'Markdown' });
    }
  } else if (data === 'pause') {
    const s = activeBots.get(chatId); if (s) s.paused = true;
    savePlatformState();
    bot.sendMessage(chatId, '⏸️ Paused.');
  } else if (data === 'resume') {
    const s = activeBots.get(chatId); if (s) s.paused = false;
    savePlatformState();
    bot.sendMessage(chatId, '▶️ Resumed.');
  } else if (data === 'stop') {
    const s = activeBots.get(chatId); if (s) s.running = false;
    savePlatformState();
    bot.sendMessage(chatId, '🛑 Stopped.');
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || '';
  const state = userStates.get(chatId);
  if (!state) return;

  if (state.step === 'ca') {
    if (!isAddress(text)) return void bot.sendMessage(chatId, '❌ Invalid contract address. Paste a complete 0x address.');
    try {
      const [info, pool] = await Promise.all([getTokenInfo(text), validateTokenAndPool(text)]);
      state.tokenCA = text;
      state.poolAddress = pool.poolAddress;
      state.poolFee = pool.poolFee;
      bot.sendMessage(chatId, `✅ *Token & Pool Validated*\n📛 Name: ${info.name}\n🔤 Symbol: ${info.symbol}\n🔗 CA: \`${text}\`\n🏊 Pool: \`${pool.poolAddress}\`\n💧 Liquidity: ${pool.liquidityUsd === undefined ? 'not supplied' : `$${pool.liquidityUsd.toLocaleString()}`}\n🛡 Round-trip quote: ${((pool.roundTripBps || 0) / 100).toFixed(2)}%`, { parse_mode: 'Markdown' });
      state.step = 'package';
      await sendPackageMenu(chatId);
    } catch (error: any) {
      bot.sendMessage(chatId, `❌ Token safety check failed: ${error?.message || error}`);
    }
  } else if (state.step === 'confirm' && text.toUpperCase() === 'YES') {
    state.step = 'payment';
    const baseAmount = parseUnits(state.expected, 18);
    const reducedAmount = (baseAmount * BigInt(10_000 - discountBps(chatId))) / 10_000n;
    state.expected = formatUnits(reducedAmount, 18);
    const createdBlock = await publicClient.getBlockNumber();
    const preference = currentUser(chatId);
    const order: PaymentOrder = {
      id: makeId('order'),
      chatId,
      tokenCA: state.tokenCA,
      package: state.package,
      mode: state.mode === 'bump' ? 'bump' : 'volume',
      durationMs: state.durationMs,
      expectedWei: reducedAmount.toString(),
      createdAt: Date.now(),
      createdBlock: createdBlock.toString(),
      status: 'pending',
      promoCode: preference.promoCode,
      referrerChatId: preference.referredBy,
      remindersSent: [],
    };
    state.orderId = order.id;
    platform.orders.push(order);
    savePlatformState();
    bot.sendMessage(chatId, `💰 Send *${state.expected} ETH* to:\n\`${MAIN_WALLET}\`\n\nInvoice: \`${order.id}\`\nOnly a confirmed, unclaimed transaction will be credited.\nReply *PAID* when done.`, { parse_mode: 'Markdown' });
  } else if (state.step === 'payment' && text.toUpperCase() === 'PAID') {
    state.step = 'payment_processing';
    void handlePayment(chatId, state.expected, state);
  } else if (state.step === 'payment_processing' && text.toUpperCase() === 'PAID') {
    bot.sendMessage(chatId, '⏳ Payment verification is already running.');
  }
}); 

async function resumePersistedSessions(): Promise<void> {
  const resumable = Array.from(activeBots.entries());
  if (resumable.length) log(`Resuming ${resumable.length} persisted session(s)`);
  for (const [chatId, session] of resumable) {
    if (session.setupStatus === 'funding') {
      void completeFundingSession(chatId, session)
        .then(() => {
          bot.sendMessage(chatId, '♻️ Paid-order wallet funding recovered after restart.').catch(() => {});
          return startVolume(chatId, true);
        })
        .catch((error: any) => {
          log(`Funding recovery failed for ${chatId}: ${error?.message || error}`, 'ERROR');
          bot.sendMessage(chatId, '⚠️ Paid-order recovery is waiting for administrator assistance. Your payment remains recorded.').catch(() => {});
        });
    } else {
      void startVolume(chatId, true);
    }
  }
  if (Number.isSafeInteger(ADMIN_CHAT_ID)) {
    bot.sendMessage(ADMIN_CHAT_ID, `🟢 Worker started\nRecovered sessions: ${resumable.length}\nStored orders: ${platform.orders.length}`).catch(() => {});
  }
}

setInterval(() => {
  const now = Date.now();
  for (const order of platform.orders) {
    order.remindersSent ??= [];
    if (order.status === 'pending' && now - order.createdAt > 5 * 60_000 && !order.remindersSent.includes('payment_5m')) {
      order.remindersSent.push('payment_5m');
      bot.sendMessage(order.chatId, `⏰ Invoice ${order.id} is still awaiting payment. It will expire when the verification window ends.`).catch(() => {});
    }
    if (order.status === 'running') {
      const session = activeBots.get(order.chatId);
      if (session && session.endTime - now <= 30 * 60_000 && session.endTime > now && !order.remindersSent.includes('ending_30m')) {
        order.remindersSent.push('ending_30m');
        bot.sendMessage(order.chatId, `⏰ Session ${order.id} has about 30 minutes remaining.`).catch(() => {});
      }
    }
  }
  savePlatformState();
}, 60_000).unref();

bot.on('polling_error', (error: Error) => {
  log(`Telegram polling error: ${error.message}`, 'ERROR');
});

process.on('SIGTERM', () => {
  savePlatformState();
  process.exit(0);
});

void resumePersistedSessions();

log('✅ Multi-user Trading Bot started - reduced wallets + weighted random 1:1/2:1/3:1 ratios');
