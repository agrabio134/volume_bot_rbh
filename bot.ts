import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  encodeFunctionData,
  maxUint256,
  isAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import TelegramBot from 'node-telegram-bot-api';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import {
  robinhood, HUH_TOKEN, WETH_TOKEN, HUH_WETH_POOL, POOL_FEE, SWAP_ROUTER,
  QUOTER_V2, COMMISSION_WALLET, CONTROLLER_WALLET, getRpcUrl,
} from './chain';

dotenv.config();

const MAIN_WALLET = CONTROLLER_WALLET;
const SUPER_ADMIN_KEY = '04012020';
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);

const DATA_FOLDER = process.env.DATA_DIR || process.cwd();
const PRIVATE_FOLDER = path.join(DATA_FOLDER, 'private_folder');
const ARCHIVE_FOLDER = path.join(DATA_FOLDER, 'archive_folder');

fs.mkdirSync(PRIVATE_FOLDER, { recursive: true });
fs.mkdirSync(ARCHIVE_FOLDER, { recursive: true });

const bot = new TelegramBot(process.env.BOT_TOKEN!, { polling: true });
const publicClient = createPublicClient({
  chain: robinhood,
  transport: http(getRpcUrl()),
});

type BotMode = 'volume' | 'bump';

type ActiveSession = {
  tokenCA: string;
  running: boolean;
  paused: boolean;
  package: string;
  mode: BotMode;
  durationMs: number;
  wallets: { privateKey: string }[];
  startTime: number;
};

const userStates = new Map<number, any>();
const activeBots = new Map<number, ActiveSession>();

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

async function quoteMinimum(tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint) {
  const { result } = await publicClient.simulateContract({
    address: QUOTER_V2, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
  });
  return (result[0] * 97n) / 100n;
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

async function executeSwap(walletPk: string, tokenCA: string, isBuy: boolean, packageType: string, durationMs: number, mode: BotMode): Promise<void> {
  const account = privateKeyToAccount(walletPk as `0x${string}`);
  const walletClient = createWalletClient({ chain: robinhood, transport: http(getRpcUrl()), account });
  const tokenInfo = await getTokenInfo(tokenCA);
  const router = SWAP_ROUTER;

  const nativeBalance = await publicClient.getBalance({ address: account.address });

  if (isBuy) {
    // Scale each trade to the wallet balance so every package uses safe, proportional sizing.
    const baseBps = [350, 450, 550, 650][Math.floor(Math.random() * 4)];
    const aggression = Math.min(3.2, 3600000 * 3.0 / durationMs);
    const tradeBps = BigInt(Math.floor(baseBps * aggression));
    const rawAmountIn = (nativeBalance * tradeBps) / 10000n;

    if (nativeBalance < rawAmountIn + parseUnits('0.00002', 18)) throw new Error('Insufficient ETH for buy and gas');

    const amountOutMinimum = await quoteMinimum(WETH_TOKEN, HUH_TOKEN, rawAmountIn);

    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{ tokenIn: WETH_TOKEN, tokenOut: HUH_TOKEN, fee: POOL_FEE, recipient: account.address, amountIn: rawAmountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
    });

    const txHash = await walletClient.sendTransaction({ 
      to: router, data, value: rawAmountIn, gas: 950000n 
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
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

    const amountOutMinimum = await quoteMinimum(HUH_TOKEN, WETH_TOKEN, rawAmountIn);
    const swapData = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{ tokenIn: HUH_TOKEN, tokenOut: WETH_TOKEN, fee: POOL_FEE, recipient: router, amountIn: rawAmountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
    });
    const unwrapData = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'unwrapWETH9', args: [amountOutMinimum, account.address] });
    const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [[swapData, unwrapData]] });

    const txHash = await walletClient.sendTransaction({ 
      to: router, data, value: 0n, gas: 950000n 
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  }
}

function chooseBuyCount(): number {
  const roll = Math.random();
  if (roll < 0.25) return 1;
  if (roll < 0.85) return 2;
  return 3;
}

async function startVolume(chatId: number): Promise<void> {
  const session = activeBots.get(chatId)!;
  const endTime = Date.now() + session.durationMs;
  const tokenInfo = await getTokenInfo(session.tokenCA);
  const modeLabel = session.mode === 'bump' ? 'Random Bump Mode' : 'Volume Mode';
  const ratioLabel = 'Random 1:1 / 2:1 / 3:1 (2:1 most common)';

  bot.sendMessage(chatId, `🚀 *Bot Started*\n\n⚙️ Mode: ${modeLabel}\n📛 Token: ${tokenInfo.name} (${tokenInfo.symbol})\n🔗 CA: \`${session.tokenCA}\`\n💎 Package: ${session.package}\n⚖️ Ratio: ${ratioLabel}\n⏱ Duration: ${Math.floor(session.durationMs/3600000)}h ${Math.floor((session.durationMs%3600000)/60000)}m\n👥 Wallets: ${session.wallets.length}`, { parse_mode: 'Markdown' });

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
          await executeSwap(w.privateKey, session.tokenCA, true, session.package, session.durationMs, session.mode);
          await sleep(session.mode === 'bump' ? jitter(2400, 4800) : jitter(1350, 1850));
        }
        await executeSwap(w.privateKey, session.tokenCA, false, session.package, session.durationMs, session.mode);
        await sleep(session.mode === 'bump' ? jitter(3800, 6200) : jitter(2100, 2800));
      } catch (e: any) {
        log(`Swap error chatId ${chatId}: ${e.message}`, 'ERROR');
        await sleep(10000);
      }
    }

    // Duration-aware pause between full wallet cycles
    const cyclePause = jitter(baseCycleDelay, baseCycleDelay * (session.mode === 'bump' ? 1.2 : 0.6));
    await sleep(Math.min(cyclePause, session.mode === 'bump' ? 45000 : 25000));
  }

  session.running = false;
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
  const filename = `${date}_${chatId}_${tokenCA.slice(0, 10)}.txt`;
  const filePath = path.join(PRIVATE_FOLDER, filename);
  fs.writeFileSync(filePath, wallets.map(w => w.privateKey).join('\n'));
  log(`Wallets saved to ${filePath}`);
}

async function fundWallets(wallets: { privateKey: string }[], amountPerWallet: string): Promise<void> {
  if (!process.env.PRIVATE_KEY) return;
  const mainAcc = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const wc = createWalletClient({ chain: robinhood, transport: http(getRpcUrl()), account: mainAcc });
  const value = parseUnits(amountPerWallet, 18);
  for (const w of wallets) {
    try {
      const acc = privateKeyToAccount(w.privateKey as `0x${string}`);
      const txHash = await wc.sendTransaction({ to: acc.address, value, gas: 50000n });
      await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    } catch (e) {
      log(`Funding failed for wallet: ${e}`, 'WARN');
    }
    await sleep(480);
  }
}

async function handlePayment(chatId: number, expectedAmount: string, state: any): Promise<void> {
  const expected = parseUnits(expectedAmount, 18);
  const balanceBeforePayment = (state.balanceBeforePayment ?? 0n) as bigint;
  const requiredBalance = balanceBeforePayment + expected;
  bot.sendMessage(chatId, `⏳ Verifying *${expectedAmount} ETH* on \`${MAIN_WALLET}\``, { parse_mode: 'Markdown' });
  for (let i = 0; i < 72; i++) {
    if (i > 0) await sleep(5000);
    try {
      const balance = await publicClient.getBalance({ address: MAIN_WALLET });
      // Also accept an already-funded controller balance. This covers WETH payments
      // that were manually unwrapped after the original verification window expired.
      const hasNewPayment = balance >= requiredBalance;
      const hasUnclaimedPrefunding = balanceBeforePayment >= expected && balance >= expected;
      if (hasNewPayment || hasUnclaimedPrefunding) {
        // Claim this order before any awaited setup work so no second PAID
        // message or verifier can confirm the same payment again.
        userStates.delete(chatId);
        await bot.sendMessage(chatId, '✅ Payment confirmed! Preparing wallets…', { parse_mode: 'Markdown' });

        try {
          if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY is not configured');
          const mainAcc = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
          const wc = createWalletClient({ chain: robinhood, transport: http(getRpcUrl()), account: mainAcc });
          const commission = (expected * 20n) / 100n;
          const commissionHash = await wc.sendTransaction({ to: COMMISSION_WALLET, value: commission, gas: 50000n });
          await publicClient.waitForTransactionReceipt({ hash: commissionHash, confirmations: 1 });

          const mode: BotMode = state.mode === 'bump' ? 'bump' : 'volume';
          const walletCount = getWalletCount(state.package, mode);
          const sessionWallets = generateWallets(walletCount);
          saveWalletsToFile(chatId, state.tokenCA, sessionWallets);

          const usable = (expected * 80n) / 100n;
          const perWallet = usable / BigInt(walletCount);
          await fundWallets(sessionWallets, formatUnits(perWallet, 18));

          activeBots.set(chatId, {
            tokenCA: state.tokenCA,
            running: true,
            paused: false,
            package: state.package,
            mode,
            durationMs: state.durationMs,
            wallets: sessionWallets,
            startTime: Date.now()
          });

          void startVolume(chatId);
        } catch (error: any) {
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
      const wc2 = createWalletClient({ chain: robinhood, transport: http(getRpcUrl()), account: acc });
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
  const files = fs.readdirSync(PRIVATE_FOLDER).filter(f => f.endsWith('.txt'));
  const allKeys: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(PRIVATE_FOLDER, file), 'utf8');
    const keys = content.split('\n').map(l => l.trim()).filter(l => l && l.startsWith('0x'));
    allKeys.push(...keys);
  }
  return allKeys;
}

async function moveToArchive(): Promise<void> {
  const files = fs.readdirSync(PRIVATE_FOLDER).filter(f => f.endsWith('.txt'));
  for (const file of files) {
    fs.renameSync(path.join(PRIVATE_FOLDER, file), path.join(ARCHIVE_FOLDER, file));
  }
  log(`Moved ${files.length} files to archive_folder`);
}

async function refundAllAdmin(chatId: number, key: string): Promise<void> {
  if (key !== SUPER_ADMIN_KEY) {
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
      const wc = createWalletClient({ chain: robinhood, transport: http(getRpcUrl()), account });
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
  if (!Number.isSafeInteger(ADMIN_CHAT_ID) || chatId !== ADMIN_CHAT_ID || key !== SUPER_ADMIN_KEY) {
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
      const wc = createWalletClient({ chain: robinhood, transport: http(getRpcUrl()), account });
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

// ==================== COMMANDS ====================

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '🚀 *Robinhood Chain HUH/WETH Trading Bot*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🚀 Start Volume Boost', callback_data: 'start_boost' }],
      [{ text: '📈 Start Random Bump Mode', callback_data: 'start_bump' }],
    ] },
  });
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
  bot.sendMessage(chatId, `📊 *Active Session*\nMode: ${session.mode === 'bump' ? 'Random Bump' : 'Volume'}\nToken: \`${session.tokenCA}\`\nPackage: ${session.package}\nWallets: ${session.wallets.length}\nDuration: ${Math.floor(session.durationMs/3600000)}h\nElapsed: ${elapsed} min\nStatus: ${session.paused ? '⏸️ PAUSED' : '▶️ RUNNING'}`, {
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
  bot.sendMessage(msg.chat.id, `🔍 Status:\nMode: ${session.mode}\nToken: ${session.tokenCA}\nWallets: ${session.wallets.length}\nRunning: ${session.running}\nPaused: ${session.paused}`);
});

bot.onText(/\/status_admin (\S+)/, async (msg, match) => {
  const providedKey = match?.[1];
  if (providedKey === SUPER_ADMIN_KEY) {
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

bot.onText(/\/refundalladmin (\S+)/, (msg, match) => {
  const key = match?.[1];
  refundAllAdmin(msg.chat.id, key || '');
});

bot.onText(/\/consolidateadmin (\S+)/, (msg, match) => {
  const key = match?.[1];
  consolidateAllAdmin(msg.chat.id, key || '');
});

bot.onText(/\/active/, (msg) => {
  const session = activeBots.get(msg.chat.id);
  if (session) bot.sendMessage(msg.chat.id, `✅ You have 1 active bot running.`);
  else bot.sendMessage(msg.chat.id, `❌ No active bot.`);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, 
`📋 *Available Commands*

/start - Choose volume or bump mode
/bump - Start random bump mode
/myorders - View active session
/status - Check current status
/active - Check if you have running bot
/stop - Stop current bot
/help - This message`, { parse_mode: 'Markdown' });
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
    bot.sendMessage(chatId, '⏸️ Paused.');
  } else if (data === 'resume') {
    const s = activeBots.get(chatId); if (s) s.paused = false;
    bot.sendMessage(chatId, '▶️ Resumed.');
  } else if (data === 'stop') {
    const s = activeBots.get(chatId); if (s) s.running = false;
    bot.sendMessage(chatId, '🛑 Stopped.');
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || '';
  const state = userStates.get(chatId);
  if (!state) return;

  if (state.step === 'ca' && isAddress(text)) {
    state.tokenCA = text;
    const info = await getTokenInfo(text);
    bot.sendMessage(chatId, `✅ *Token Detected*\n📛 Name: ${info.name}\n🔤 Symbol: ${info.symbol}\n🔗 CA: \`${text}\``, { parse_mode: 'Markdown' });
    state.step = 'package';
    await sendPackageMenu(chatId);
  } else if (state.step === 'confirm' && text.toUpperCase() === 'YES') {
    state.step = 'payment';
    state.balanceBeforePayment = await publicClient.getBalance({ address: MAIN_WALLET });
    bot.sendMessage(chatId, `💰 Send *${state.expected} ETH* to:\n\`${MAIN_WALLET}\`\n\nReply *PAID* when done.`, { parse_mode: 'Markdown' });
  } else if (state.step === 'payment' && text.toUpperCase() === 'PAID') {
    state.step = 'payment_processing';
    void handlePayment(chatId, state.expected, state);
  } else if (state.step === 'payment_processing' && text.toUpperCase() === 'PAID') {
    bot.sendMessage(chatId, '⏳ Payment verification is already running.');
  }
}); 

log('✅ Multi-user Trading Bot started - reduced wallets + weighted random 1:1/2:1/3:1 ratios');
