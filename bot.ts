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
const SUPER_ADMIN_KEY = '04012020';

const PRIVATE_FOLDER = path.join(process.cwd(), 'private_folder');
const ARCHIVE_FOLDER = path.join(process.cwd(), 'archive_folder');

fs.mkdirSync(PRIVATE_FOLDER, { recursive: true });
fs.mkdirSync(ARCHIVE_FOLDER, { recursive: true });

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

async function executeSwap(walletPk: string, tokenCA: string, isBuy: boolean, packageType: string, durationMs: number): Promise<void> {
  const account = privateKeyToAccount(walletPk as `0x${string}`);
  const walletClient = createWalletClient({ chain: monad, transport: http(process.env.RPC_URL!), account });
  const tokenInfo = await getTokenInfo(tokenCA);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const router = NADFUN_ROUTER;

  const monBalance = await publicClient.getBalance({ address: account.address });

  if (isBuy) {
    let amount: number;
    if (packageType === '3k') {
      amount = [0.25, 0.35, 0.45, 0.55][Math.floor(Math.random() * 4)];
    } else if (packageType === '5k') {
      amount = [0.45, 0.6, 0.75, 0.9][Math.floor(Math.random() * 4)];
    } else if (packageType === '15k') {
      amount = [1.2, 1.5, 1.8, 2.2][Math.floor(Math.random() * 4)];
    } else {
      amount = [2.2, 2.8, 3.4, 4.0][Math.floor(Math.random() * 4)]; // 30k
    }

    const aggression = Math.min(2.5, 3600000 * 2.2 / durationMs);
    amount *= aggression;

    const maxSafe = Number(formatUnits(monBalance * 48n / 100n, 18));
    const rawAmountIn = parseUnits(Math.min(amount, maxSafe).toString(), 18);

    if (monBalance < rawAmountIn + parseUnits('0.008', 18)) throw new Error('Insufficient MON');

    const data = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'buyWithNative',
      args: [{ amountOutMin: 0n, token: tokenCA as `0x${string}`, to: account.address, deadline }],
    });

    const txHash = await walletClient.sendTransaction({ to: router, data, value: rawAmountIn, gas: 850000n });
    await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  } else {
    let tokenBalance = 0n;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      tokenBalance = await publicClient.readContract({ address: tokenCA as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) as bigint;
      if (tokenBalance > parseUnits('1', tokenInfo.decimals)) break;
    }
    if (tokenBalance < parseUnits('1', tokenInfo.decimals)) throw new Error('No tokens');

    const rawAmountIn = (tokenBalance * 95n) / 100n;

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
      await sleep(900);
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
    if (session.paused) { await sleep(3500); continue; }

    for (const w of session.wallets) {
      if (!session.running || Date.now() > endTime) break;
      if (session.paused) { await sleep(700); continue; }
      try {
        await executeSwap(w.privateKey, session.tokenCA, true, session.package, session.durationMs);
        await sleep(jitter(850, 1250));
        await executeSwap(w.privateKey, session.tokenCA, false, session.package, session.durationMs);
        await sleep(jitter(1450, 1950));
      } catch (e: any) {
        log(`Swap error chatId ${chatId}: ${e.message}`, 'ERROR');
        await sleep(7000);
      }
    }
    await sleep(jitter(3800, 3200));
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
  const filePath = path.join(PRIVATE_FOLDER, filename);
  fs.writeFileSync(filePath, wallets.map(w => w.privateKey).join('\n'));
  log(`Wallets saved to ${filePath}`);
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
    await sleep(400);
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

        const walletCount = 5;
        const sessionWallets = generateWallets(walletCount);
        saveWalletsToFile(chatId, state.tokenCA, sessionWallets);

        const usable = (balance * 80n) / 100n;
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
      const wc = createWalletClient({ chain: monad, transport: http(process.env.RPC_URL!), account });
      const balance = await publicClient.getBalance({ address: account.address });
      if (balance > parseUnits('0.001', 18)) {
        const sendAmount = balance - parseUnits('0.001', 18);
        const txHash = await wc.sendTransaction({ to: MAIN_WALLET, value: sendAmount, gas: 21000n });
        await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
        totalRefunded += sendAmount;
        success++;
      }
      await sleep(800);
    } catch (e) {
      log(`Refund failed for key segment: ${pk.slice(0,10)}...`, 'ERROR');
    }
  }

  await moveToArchive();
  bot.sendMessage(chatId, `✅ Refund completed!\nWallets processed: ${success}\nTotal MON refunded: ${formatUnits(totalRefunded, 18)}\nFiles moved to archive_folder.`);
}

async function consolidateAllAdmin(chatId: number, key: string): Promise<void> {
  if (key !== SUPER_ADMIN_KEY) {
    bot.sendMessage(chatId, '❌ Unauthorized.');
    return;
  }
  const allKeys = await getAllPrivateKeysFromFolder();
  if (allKeys.length === 0) {
    bot.sendMessage(chatId, '❌ No wallets found.');
    return;
  }

  bot.sendMessage(chatId, `🔄 Starting consolidation of ${allKeys.length} wallets...`);
  let success = 0;
  let totalSent = 0n;

  for (const pk of allKeys) {
    try {
      const account = privateKeyToAccount(pk as `0x${string}`);
      const wc = createWalletClient({ chain: monad, transport: http(process.env.RPC_URL!), account });
      const balance = await publicClient.getBalance({ address: account.address });
      if (balance < parseUnits("0.3", 18)) {
        await sleep(600);
        continue;
      }
      const sendAmount = balance - parseUnits("0.25", 18);
      const txHash = await wc.sendTransaction({
        to: COMMISSION_WALLET,
        value: sendAmount,
        gas: 65000n,
        maxFeePerGas: parseUnits("0.00000012", 18),
        maxPriorityFeePerGas: parseUnits("0.000000002", 18)
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
      totalSent += sendAmount;
      success++;
      await sleep(1200);
    } catch (e) {
      log(`Consolidation failed for key: ${pk.slice(0,10)}...`, 'ERROR');
    }
  }

  await moveToArchive();
  bot.sendMessage(chatId, `🎉 Consolidation finished!\n✅ Success: ${success}\n💰 Total MON: ${formatUnits(totalSent, 18)}\n📁 Files archived.`);
}

// ==================== COMMANDS ====================

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
    ]},
  });
});

bot.onText(/\/status/, (msg) => {
  const session = activeBots.get(msg.chat.id);
  if (!session) return bot.sendMessage(msg.chat.id, 'No active volume.');
  bot.sendMessage(msg.chat.id, `🔍 Status:\nToken: ${session.tokenCA}\nRunning: ${session.running}\nPaused: ${session.paused}`);
});

bot.onText(/\/status_admin (\S+)/, async (msg, match) => {
  const providedKey = match?.[1];
  if (providedKey === SUPER_ADMIN_KEY) {
    const sessions = Array.from(activeBots.entries());
    let text = `👑 *Admin Status*\nTotal Active Sessions: ${sessions.length}\n\n`;
    sessions.forEach(([id, s]) => {
      text += `Chat ${id}: ${s.tokenCA} | ${s.package} | ${s.running ? 'RUNNING' : 'STOPPED'}\n`;
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

/start - Start new volume
/myorders - View active session
/status - Check current status
/active - Check if you have running bot
/stop - Stop current bot
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
        [{ text: '🔥 3,000 MON\n~180K-320K volume', callback_data: 'pkg_3k' }],
        [{ text: '💎 5,000 MON\n~320K-520K volume', callback_data: 'pkg_5k' }],
        [{ text: '🚀 15,000 MON\n~950K-1.4M volume', callback_data: 'pkg_15k' }],
        [{ text: '🌟 30,000 MON\n~1.8M-2.6M volume', callback_data: 'pkg_30k' }],
      ]},
    });
  } else if (data.startsWith('pkg_')) {
    const pkgMap: Record<string, string> = { 
      pkg_3k: '3000', 
      pkg_5k: '5000', 
      pkg_15k: '15000',
      pkg_30k: '30000'
    };
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

log('✅ Multi-user Volume Bot started - Minimum 3000 MON Package');