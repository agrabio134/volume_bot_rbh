import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  encodeFunctionData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import TelegramBot from 'node-telegram-bot-api';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';

dotenv.config();

const monad = {
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
} as const;

const NADFUN_ROUTER = '0x8986C8fD44eb85294A725a7e61AF35E76bA26F91' as `0x${string}`;
const MAIN_WALLET = '0xfadbba931c41af2596299499b9373f6aff12358e' as `0x${string}`;
const COMMISSION_WALLET = '0xfe8c776314e296eb17b8b7aba33082add5b35b0d' as `0x${string}`;

const bot = new TelegramBot(process.env.BOT_TOKEN!, { polling: true });
const publicClient = createPublicClient({
  chain: monad,
  transport: http(process.env.RPC_URL || 'https://rpc.monad.xyz'),
});

const userStates = new Map<number, any>();
const activeBots = new Map<number, { 
  tokenCA: string; 
  running: boolean; 
  paused: boolean; 
  package: string; 
  durationMs: number;
  wallets: { privateKey: string }[];
  startTime: number;
}>();

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
    name: 'buyWithNative',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ]}],
    outputs: [],
  },
  {
    name: 'sellToNative',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ]}],
    outputs: [],
  },
] as const;

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

async function executeSwap(walletPk: string, tokenCA: string, isBuy: boolean, packageType: string): Promise<void> {
  const account = privateKeyToAccount(walletPk as `0x${string}`);
  const walletClient = createWalletClient({ chain: monad, transport: http(process.env.RPC_URL!), account });
  const tokenInfo = await getTokenInfo(tokenCA);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const router = NADFUN_ROUTER;

  if (isBuy) {
    let amount: number;
    if (packageType === 'test') amount = [0.008, 0.012, 0.016][Math.floor(Math.random() * 3)];
    else if (packageType === '5k') amount = [0.022, 0.03, 0.038, 0.045][Math.floor(Math.random() * 4)];
    else amount = [0.045, 0.06, 0.075, 0.09][Math.floor(Math.random() * 4)];

    const rawAmountIn = parseUnits(amount.toString(), 18);
    const monBalance = await publicClient.getBalance({ address: account.address });
    if (monBalance < rawAmountIn + parseUnits('0.003', 18)) throw new Error('Insufficient MON');

    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'buyWithNative',
      args: [{ amountOutMin: 0n, token: tokenCA as `0x${string}`, to: account.address, deadline }],
    });

    const txHash = await walletClient.sendTransaction({ to: router, data, value: rawAmountIn, gas: 850000n });
    await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  } else {
    let tokenBalance = 0n;
    for (let i = 0; i < 15; i++) {
      await sleep(800);
      tokenBalance = await publicClient.readContract({ address: tokenCA as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) as bigint;
      if (tokenBalance > parseUnits('0.5', tokenInfo.decimals)) break;
    }
    if (tokenBalance < parseUnits('0.5', tokenInfo.decimals)) throw new Error('No tokens');

    const rawAmountIn = (tokenBalance * 93n) / 100n;

    const allowance = await publicClient.readContract({ address: tokenCA as `0x${string}`, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, router] }) as bigint;
    if (allowance < rawAmountIn) {
      const approveTx = await walletClient.writeContract({
        address: tokenCA as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [router, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')],
        gas: 150000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, confirmations: 1 });
      await sleep(1200);
    }

    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'sellToNative',
      args: [{ amountIn: rawAmountIn, amountOutMin: 0n, token: tokenCA as `0x${string}`, to: account.address, deadline }],
    });

    const txHash = await walletClient.sendTransaction({ to: router, data, value: 0n, gas: 850000n });
    await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  }
}

async function startVolume(chatId: number): Promise<void> {
  const session = activeBots.get(chatId)!;
  const endTime = Date.now() + session.durationMs;
  const tokenInfo = await getTokenInfo(session.tokenCA);

  bot.sendMessage(chatId, `🚀 *Volume Bot Started*\n\n📛 Token: ${tokenInfo.name} (${tokenInfo.symbol})\n🔗 CA: \`${session.tokenCA}\`\n💎 Package: ${session.package}\n⏱ Duration: ${Math.floor(session.durationMs/3600000)}h ${Math.floor((session.durationMs%3600000)/60000)}m\n👥 Wallets: ${session.wallets.length}`, { parse_mode: 'Markdown' });

  while (session.running && Date.now() < endTime) {
    if (session.paused) { await sleep(5000); continue; }

    for (const w of session.wallets) {
      if (!session.running || Date.now() > endTime) break;
      if (session.paused) { await sleep(1000); continue; }
      try {
        await executeSwap(w.privateKey, session.tokenCA, true, session.package);
        await sleep(jitter(1400, 2200));
        await executeSwap(w.privateKey, session.tokenCA, false, session.package);
        await sleep(jitter(2800, 3200));
      } catch (e: any) {
        log(`Swap error chatId ${chatId}: ${e.message}`, 'ERROR');
        await sleep(10000);
      }
    }
    await sleep(jitter(6500, 5500));
  }
  session.running = false;
  bot.sendMessage(chatId, '🛑 Volume bot finished.').catch(() => {});
}

function generateWallets(count = 5) {
  const wallets: { privateKey: string }[] = [];
  for (let i = 0; i < count; i++) {
    const privateKey = '0x' + crypto.randomBytes(32).toString('hex');
    wallets.push({ privateKey });
  }
  return wallets;
}

function saveWalletsToFile(chatId: number, tokenCA: string, wallets: { privateKey: string }[]) {
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${date}_${chatId}_${tokenCA.slice(0, 10)}.txt`;
  fs.writeFileSync(path.join(process.cwd(), filename), wallets.map(w => w.privateKey).join('\n'));
}

async function fundWallets(wallets: { privateKey: string }[], amountPerWallet: string): Promise<void> {
  if (!process.env.PRIVATE_KEY) return;
  const mainAcc = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const wc = createWalletClient({ chain: monad, transport: http(process.env.RPC_URL!), account: mainAcc });
  const value = parseUnits(amountPerWallet, 18);
  for (const w of wallets) {
    try {
      const acc = privateKeyToAccount(w.privateKey as `0x${string}`);
      const txHash = await wc.sendTransaction({ to: acc.address, value, gas: 21000n });
      await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    } catch {}
    await sleep(500);
  }
}

async function handlePayment(chatId: number, expectedAmount: string, state: any): Promise<void> {
  const expected = parseUnits(expectedAmount, 18);
  bot.sendMessage(chatId, `⏳ Verifying *${expectedAmount} MON* on \`${MAIN_WALLET}\``, { parse_mode: 'Markdown' });
  for (let i = 0; i < 72; i++) {
    if (i > 0) await sleep(5000);
    try {
      const balance = await publicClient.getBalance({ address: MAIN_WALLET });
      if (balance >= expected) {
        bot.sendMessage(chatId, '✅ Payment confirmed!', { parse_mode: 'Markdown' });
        if (process.env.PRIVATE_KEY) {
          const mainAcc = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
          const wc = createWalletClient({ chain: monad, transport: http(process.env.RPC_URL!), account: mainAcc });
          const commission = (balance * 20n) / 100n;
          await wc.sendTransaction({ to: COMMISSION_WALLET, value: commission, gas: 21000n });
        }

        const walletCount = state.package === 'test' ? 25 : 5;
        const sessionWallets = generateWallets(walletCount);
        saveWalletsToFile(chatId, state.tokenCA, sessionWallets);

        const usable = (balance * 72n) / 100n;
        const perWallet = usable / BigInt(walletCount);
        await fundWallets(sessionWallets, formatUnits(perWallet, 18));

        activeBots.set(chatId, {
          tokenCA: state.tokenCA,
          running: true,
          paused: false,
          package: state.package,
          durationMs: state.durationMs,
          wallets: sessionWallets,
          startTime: Date.now()
        });

        startVolume(chatId);
        userStates.delete(chatId);
        return;
      }
    } catch {}
  }
  userStates.delete(chatId);
  bot.sendMessage(chatId, '❌ Payment not detected.');
}

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
      const wc2 = createWalletClient({ chain: monad, transport: http(process.env.RPC_URL!), account: acc });
      const balance = await publicClient.getBalance({ address: acc.address });
      if (balance > parseUnits('0.001', 18)) {
        await wc2.sendTransaction({ to: MAIN_WALLET, value: balance - parseUnits('0.001', 18), gas: 21000n });
      }
    } catch {}
    await sleep(600);
  }
  activeBots.delete(chatId);
  bot.sendMessage(chatId, '✅ Refund completed.');
}

// Commands
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '🚀 *nad.fun Volume Bot*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🚀 Start New Boost', callback_data: 'start_boost' }]] },
  });
});

bot.onText(/\/myorders/, (msg) => {
  const chatId = msg.chat.id;
  const session = activeBots.get(chatId);
  if (!session) return bot.sendMessage(chatId, '📭 No active session. Use /start');
  const elapsed = Math.floor((Date.now() - session.startTime)/60000);
  bot.sendMessage(chatId, `📊 *Active Volume*\nToken: \`${session.tokenCA}\`\nPackage: ${session.package}\nDuration: ${Math.floor(session.durationMs/3600000)}h\nElapsed: ${elapsed} min\nStatus: ${session.paused ? '⏸️ PAUSED' : '▶️ RUNNING'}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: session.paused ? '▶️ Resume' : '⏸️ Pause', callback_data: session.paused ? 'resume' : 'pause' }],
      [{ text: '🛑 Stop', callback_data: 'stop' }],
      [{ text: '🔄 Refund', callback_data: 'refund' }],
    ]},
  });
});

bot.onText(/\/status/, (msg) => {
  const session = activeBots.get(msg.chat.id);
  if (!session) return bot.sendMessage(msg.chat.id, 'No active volume.');
  bot.sendMessage(msg.chat.id, `🔍 Status:\nToken: ${session.tokenCA}\nRunning: ${session.running}\nPaused: ${session.paused}`);
});

bot.onText(/\/active/, (msg) => {
  const session = activeBots.get(msg.chat.id);
  if (session) bot.sendMessage(msg.chat.id, `✅ You have 1 active bot running.`);
  else bot.sendMessage(msg.chat.id, `❌ No active bot.`);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, 
`📋 *Available Commands*

/start - Start new volume
/myorders - View active session
/status - Check current status
/active - Check if you have running bot
/stop - Stop current bot
/refund - Refund wallets
/help - This message`, { parse_mode: 'Markdown' });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message!.chat.id;
  const data = query.data || '';
  bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'start_boost') {
    userStates.set(chatId, { step: 'package' });
    bot.sendMessage(chatId, '💎 *Choose Package*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '🧪 220 MON – Test (25 wallets)\n~8K-15K volume', callback_data: 'pkg_test' }],
        [{ text: '🔥 5,000 MON\n~180K-280K volume', callback_data: 'pkg_5k' }],
        [{ text: '💰 15,000 MON\n~550K-850K volume', callback_data: 'pkg_15k' }],
      ]},
    });
  } else if (data.startsWith('pkg_')) {
    const pkgMap: Record<string, string> = { pkg_test: '220', pkg_5k: '5000', pkg_15k: '15000' };
    const pkgType = data.replace('pkg_', '');
    const state = userStates.get(chatId);
    if (state) {
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
      state.step = 'ca';
      bot.sendMessage(chatId, '🔗 Paste Token Contract Address (CA):');
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
  } else if (data === 'refund') {
    refundAllWallets(chatId);
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || '';
  const state = userStates.get(chatId);
  if (!state) return;

  if (state.step === 'ca' && text.startsWith('0x')) {
    state.tokenCA = text;
    const info = await getTokenInfo(text);
    bot.sendMessage(chatId, `✅ *Token Detected*\n📛 Name: ${info.name}\n🔤 Symbol: ${info.symbol}\n🔗 CA: \`${text}\`\n\nReply *YES* to start volume.`, { parse_mode: 'Markdown' });
    state.step = 'confirm';
  } else if (state.step === 'confirm' && text.toUpperCase() === 'YES') {
    state.step = 'payment';
    bot.sendMessage(chatId, `💰 Send *${state.expected} MON* to:\n\`${MAIN_WALLET}\`\n\nReply *PAID* when done.`, { parse_mode: 'Markdown' });
  } else if (state.step === 'payment' && text.toUpperCase() === 'PAID') {
    handlePayment(chatId, state.expected, state);
  }
});

log('✅ Multi-user Volume Bot started with full commands');