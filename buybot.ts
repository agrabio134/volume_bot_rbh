import TelegramBot, { type Chat, type MessageEntity } from 'node-telegram-bot-api';
import {
  createPublicClient, formatUnits, isAddress, parseUnits, type Address, type Hex,
} from 'viem';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {
  robinhood, HUH_TOKEN, WETH_TOKEN, HUH_WETH_POOL, getRpcTransport,
} from './chain';

dotenv.config();

const BUYBOT_TOKEN = process.env.BUYBOT_TOKEN;
if (!BUYBOT_TOKEN) throw new Error('BUYBOT_TOKEN is required');

const ADMIN_USER_ID = Number(process.env.BUYBOT_ADMIN_USER_ID || process.env.ADMIN_CHAT_ID);
if (!Number.isSafeInteger(ADMIN_USER_ID)) throw new Error('BUYBOT_ADMIN_USER_ID is required');

const DATA_FOLDER = process.env.DATA_DIR || process.cwd();
const STATE_FILE = path.join(DATA_FOLDER, 'buybot-state.json');
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const DEXSCREENER_API = `https://api.dexscreener.com/latest/dex/pairs/robinhood/${HUH_WETH_POOL}`;
const DEXSCREENER_URL = `https://dexscreener.com/robinhood/${HUH_WETH_POOL.toLowerCase()}`;

type ChatConfig = {
  title: string;
  buyEmoji: string;
  customEmojiId?: string;
  media?: { type: 'photo' | 'animation' | 'video'; fileId: string };
  websiteUrl?: string;
  chartUrl?: string;
  buyUrl?: string;
  tokenAddress?: Address;
  poolAddress?: Address;
  poolFee?: number;
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  minimumBuyWeth?: string;
  antiSpamSeconds?: number;
  messageTemplate?: string;
  whaleTiers?: { dolphin: string; shark: string; whale: string };
  marketCapMilestones?: number[];
  lastMarketCapMilestone?: number;
  buyerMilestones?: number[];
  lastBuyerMilestone?: number;
  liquidityAlerts?: boolean;
  timezone?: string;
};

type BuyStats = {
  buys: number;
  totalWethWei: string;
  totalTokenRaw: string;
  largestWethWei: string;
  largestTxHash?: Hex;
  buyers: string[];
  startedAt: string;
  lastBuyTxHash?: Hex;
  lastBuyAt?: string;
  lastScannedBlock?: string;
};

type BuybotState = {
  enabledChatIds: number[];
  whaleThresholdWeth: string;
  chatConfigs: Record<string, ChatConfig>;
  stats: BuyStats;
  chatStats: Record<string, BuyStats>;
};

const defaultStats = (): BuyStats => ({
  buys: 0,
  totalWethWei: '0',
  totalTokenRaw: '0',
  largestWethWei: '0',
  buyers: [],
  startedAt: new Date().toISOString(),
});

const defaultState = (): BuybotState => ({
  enabledChatIds: [],
  whaleThresholdWeth: '0.10',
  chatConfigs: {},
  stats: defaultStats(),
  chatStats: {},
});

function loadState(): BuybotState {
  try {
    const defaults = defaultState();
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      ...defaults,
      ...saved,
      stats: { ...defaults.stats, ...(saved.stats || {}) },
      chatConfigs: saved.chatConfigs || {},
      chatStats: saved.chatStats || {},
    };
  } catch {
    return defaultState();
  }
}

let state = loadState();
const pendingSetup = new Map<number,
  'media' | 'emoji' | 'title' | 'website' | 'chart' | 'buy' |
  'token' | 'minbuy' | 'antispam' | 'template' | 'timezone' | 'milestones'
>();

function getChatConfig(chatId: number): ChatConfig {
  const key = String(chatId);
  state.chatConfigs[key] ??= {
    title: 'HUH BUY',
    buyEmoji: '🟢',
    tokenAddress: HUH_TOKEN,
    poolAddress: HUH_WETH_POOL,
    poolFee: 10_000,
    minimumBuyWeth: '0',
    antiSpamSeconds: 0,
    whaleTiers: { dolphin: '0.01', shark: '0.05', whale: '0.10' },
    marketCapMilestones: [100_000, 250_000, 500_000, 1_000_000, 5_000_000],
    buyerMilestones: [100, 250, 500, 1_000, 2_500, 5_000],
    liquidityAlerts: true,
    timezone: 'Asia/Manila',
  };
  return state.chatConfigs[key];
}

function getChatStats(chatId: number): BuyStats {
  const key = String(chatId);
  state.chatStats[key] ??= { ...defaultStats(), buyers: [] };
  return state.chatStats[key];
}

function saveState() {
  fs.mkdirSync(DATA_FOLDER, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const publicClient = createPublicClient({ chain: robinhood, transport: getRpcTransport() });
const bot = new TelegramBot(BUYBOT_TOKEN, { polling: true });

const POOL_ABI = [
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'fee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  {
    name: 'Swap', type: 'event', inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount0', type: 'int256', indexed: false },
      { name: 'amount1', type: 'int256', indexed: false },
      { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
      { name: 'liquidity', type: 'uint128', indexed: false },
      { name: 'tick', type: 'int24', indexed: false },
    ],
  },
  {
    name: 'Mint', type: 'event', inputs: [
      { name: 'sender', type: 'address', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'tickLower', type: 'int24', indexed: true },
      { name: 'tickUpper', type: 'int24', indexed: true },
      { name: 'amount', type: 'uint128', indexed: false },
      { name: 'amount0', type: 'uint256', indexed: false },
      { name: 'amount1', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'Burn', type: 'event', inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'tickLower', type: 'int24', indexed: true },
      { name: 'tickUpper', type: 'int24', indexed: true },
      { name: 'amount', type: 'uint128', indexed: false },
      { name: 'amount0', type: 'uint256', indexed: false },
      { name: 'amount1', type: 'uint256', indexed: false },
    ],
  },
] as const;

const ERC20_ABI = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

type ResolvedToken = {
  tokenAddress: Address;
  poolAddress: Address;
  poolFee: number;
  token0: Address;
  token1: Address;
  tokenIs0: boolean;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  dexUrl: string;
  liquidityUsd?: number;
};

async function resolveToken(tokenAddress: Address, requestedPool?: Address): Promise<ResolvedToken> {
  let poolAddress = requestedPool;
  let dexUrl = `https://dexscreener.com/robinhood/${requestedPool || tokenAddress}`;
  let liquidityUsd: number | undefined;
  if (!poolAddress) {
    const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${tokenAddress}`, { signal: AbortSignal.timeout(6_000) });
    if (!response.ok) throw new Error(`DEX Screener HTTP ${response.status}`);
    const pairs = await response.json() as Array<any>;
    const matching = pairs
      .filter(pair => pair.pairAddress && [pair.baseToken?.address?.toLowerCase(), pair.quoteToken?.address?.toLowerCase()].includes(WETH_TOKEN.toLowerCase()))
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!matching?.pairAddress) throw new Error('No WETH pool found for this token');
    poolAddress = matching.pairAddress as Address;
    dexUrl = matching.url || dexUrl;
    liquidityUsd = matching.liquidity?.usd;
  }
  const [token0, token1, poolFee, name, symbol, decimals, totalSupply] = await Promise.all([
    publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'token0' }),
    publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'token1' }),
    publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: 'fee' }),
    publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'name' }),
    publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'decimals' }),
    publicClient.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'totalSupply' }),
  ]);
  const actual = [token0.toLowerCase(), token1.toLowerCase()];
  if (!actual.includes(tokenAddress.toLowerCase()) || !actual.includes(WETH_TOKEN.toLowerCase())) {
    throw new Error('Pool must pair the selected token with WETH');
  }
  return {
    tokenAddress, poolAddress, poolFee: Number(poolFee), token0, token1,
    tokenIs0: token0.toLowerCase() === tokenAddress.toLowerCase(),
    name, symbol, decimals: Number(decimals), totalSupply, dexUrl, liquidityUsd,
  };
}

async function isAuthorized(chat: Chat, userId?: number): Promise<boolean> {
  if (!userId) return false;
  if (userId === ADMIN_USER_ID) return true;
  if (chat.type === 'private') return false;
  try {
    const administrators = await bot.getChatAdministrators(chat.id);
    return administrators.some(member => member.user.id === userId);
  } catch (error: any) {
    console.error(`[buybot admin check] ${error?.message || error}`);
    return false;
  }
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function compact(value: string, maximumFractionDigits = 6): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  if (numeric > 0 && numeric < 0.000001) return numeric.toExponential(4);
  return numeric.toLocaleString('en-US', { maximumFractionDigits });
}

function compactUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  return `$${new Intl.NumberFormat('en-US', {
    notation: value >= 1_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1_000 ? 2 : 4,
  }).format(value)}`;
}

function statsText(chatId: number, symbol: string, tokenDecimals: number): string {
  const stats = getChatStats(chatId);
  const totalWeth = formatUnits(BigInt(stats.totalWethWei), 18);
  const totalToken = formatUnits(BigInt(stats.totalTokenRaw), tokenDecimals);
  const largest = formatUnits(BigInt(stats.largestWethWei), 18);
  const uptimeMs = Date.now() - new Date(stats.startedAt).getTime();
  const hours = Math.floor(uptimeMs / 3_600_000);
  const minutes = Math.floor((uptimeMs % 3_600_000) / 60_000);
  return [
    `📊 <b>${esc(symbol)} BUYBOT STATS</b>`,
    '━━━━━━━━━━━━━━',
    `<blockquote>🟢 Total buys      <b>${stats.buys}</b>\n💰 Buy volume     <b>${compact(totalWeth)} WETH</b>\n🪙 Tokens bought  <b>${compact(totalToken, 2)} ${esc(symbol)}</b>\n👥 Unique buyers  <b>${stats.buyers.length}</b>\n🐋 Largest buy    <b>${compact(largest)} WETH</b></blockquote>`,
    `⏱ Tracking for <b>${hours}h ${minutes}m</b>`,
  ].join('\n');
}

async function main() {
  const [token0, token1, tokenName, symbol, tokenDecimals, totalSupply, me] = await Promise.all([
    publicClient.readContract({ address: HUH_WETH_POOL, abi: POOL_ABI, functionName: 'token0' }),
    publicClient.readContract({ address: HUH_WETH_POOL, abi: POOL_ABI, functionName: 'token1' }),
    publicClient.readContract({ address: HUH_TOKEN, abi: ERC20_ABI, functionName: 'name' }),
    publicClient.readContract({ address: HUH_TOKEN, abi: ERC20_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: HUH_TOKEN, abi: ERC20_ABI, functionName: 'decimals' }),
    publicClient.readContract({ address: HUH_TOKEN, abi: ERC20_ABI, functionName: 'totalSupply' }),
    bot.getMe(),
  ]);

  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  if (![t0, t1].includes(HUH_TOKEN.toLowerCase()) || ![t0, t1].includes(WETH_TOKEN.toLowerCase())) {
    throw new Error('Configured pool is not the configured HUH/WETH pair');
  }
  const huhIsToken0 = t0 === HUH_TOKEN.toLowerCase();
  const Q192 = 1n << 192n;
  const oneToken = 10n ** BigInt(tokenDecimals);

  function marketData(sqrtPriceX96: bigint) {
    const squared = sqrtPriceX96 * sqrtPriceX96;
    const priceWethWei = huhIsToken0
      ? (squared * oneToken) / Q192
      : (Q192 * oneToken) / squared;
    const marketCapWethWei = (priceWethWei * totalSupply) / oneToken;
    return {
      priceWeth: formatUnits(priceWethWei, 18),
      marketCapWeth: formatUnits(marketCapWethWei, 18),
    };
  }

  type DexMarket = {
    priceNative?: string;
    priceUsd?: string;
    marketCap?: number;
    fdv?: number;
    liquidity?: { usd?: number };
    volume?: { h24?: number };
    priceChange?: { h24?: number };
    url?: string;
  };
  let dexCache: { value?: DexMarket; fetchedAt: number } = { fetchedAt: 0 };

  async function getDexMarket(): Promise<DexMarket | undefined> {
    if (Date.now() - dexCache.fetchedAt < 5_000) return dexCache.value;
    try {
      const response = await fetch(DEXSCREENER_API, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { pairs?: DexMarket[] };
      dexCache = { value: payload.pairs?.[0], fetchedAt: Date.now() };
      return dexCache.value;
    } catch (error: any) {
      console.error(`[buybot dexscreener] ${error?.message || error}`);
      dexCache.fetchedAt = Date.now();
      return dexCache.value;
    }
  }

  function renderEmoji(config: ChatConfig): string {
    const fallback = esc(config.buyEmoji || '🟢');
    return config.customEmojiId && /^\d+$/.test(config.customEmojiId)
      ? `<tg-emoji emoji-id="${config.customEmojiId}">${fallback}</tg-emoji>`
      : fallback;
  }

  function alertButtons(chatId: number, txHash?: Hex) {
    const config = getChatConfig(chatId);
    const rows: Array<Array<{ text: string; url: string }>> = [];
    const projectLinks: Array<{ text: string; url: string }> = [];
    if (config.websiteUrl) projectLinks.push({ text: '🌐 Website', url: config.websiteUrl });
    projectLinks.push({ text: '📈 Chart', url: config.chartUrl || DEXSCREENER_URL });
    if (config.buyUrl) projectLinks.push({ text: '🛒 Buy', url: config.buyUrl });
    if (projectLinks.length) rows.push(projectLinks);
    if (txHash) rows.push([{ text: '🔎 Transaction', url: `${EXPLORER}/tx/${txHash}` }]);
    return rows.length ? { inline_keyboard: rows } : undefined;
  }

  async function sendRichAlert(chatId: number, html: string, txHash?: Hex) {
    const config = getChatConfig(chatId);
    const options = {
      parse_mode: 'HTML' as const,
      reply_markup: alertButtons(chatId, txHash),
    };
    try {
      if (config.media?.type === 'photo') return await bot.sendPhoto(chatId, config.media.fileId, { ...options, caption: html });
      if (config.media?.type === 'animation') return await bot.sendAnimation(chatId, config.media.fileId, { ...options, caption: html });
      if (config.media?.type === 'video') return await bot.sendVideo(chatId, config.media.fileId, { ...options, caption: html });
      return await bot.sendMessage(chatId, html, { ...options, link_preview_options: { is_disabled: true } });
    } catch (error: any) {
      console.error(`[buybot media] ${error?.message || error}`);
      const plainEmojiHtml = html.replace(/<tg-emoji emoji-id="\d+">([\s\S]*?)<\/tg-emoji>/g, '$1');
      return bot.sendMessage(chatId, plainEmojiHtml, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }
  }

  async function sendPreview(chatId: number) {
    const config = getChatConfig(chatId);
    const configuredToken = config.tokenAddress || HUH_TOKEN;
    const configuredName = config.tokenName || tokenName;
    const configuredSymbol = config.tokenSymbol || symbol;
    const emoji = renderEmoji(config);
    const html = [
      `${emoji}${emoji}${emoji}${emoji}${emoji}${emoji}`,
      `🔥 <b>${esc(config.title)}</b> 🔥`,
      `${emoji}${emoji}${emoji}${emoji}${emoji}${emoji}`,
      '',
      `<blockquote><b>💸 BUY DETAILS</b>\n💰 Spent: <b>0.123 WETH</b>\n💵 Value: <b>$232.50</b>\n🪙 Received: <b>12,345 ${esc(configuredSymbol)}</b></blockquote>`,
      `<b>📊 ${esc(configuredName)} MARKET</b>`,
      '💵 DEX price: <b>$0.0002672</b>',
      '📊 DEX market cap: <b>$267,219</b>',
      '💧 Liquidity: <b>$50,000</b>',
      '📈 24h volume: <b>$25,000</b>',
      '',
      `👤 <a href="${EXPLORER}/address/${configuredToken}">0x1234…5678</a>`,
      `📄 CA: <code>${configuredToken}</code>`,
      '<i>Preview — no transaction occurred</i>',
    ].join('\n');
    await sendRichAlert(chatId, html);
  }

  await bot.setMyCommands([
    { command: 'setup', description: 'Open the easy setup menu' },
    { command: 'stats', description: 'Show buy statistics' },
    { command: 'health', description: 'Watcher and RPC health' },
    { command: 'testalert', description: 'Send a preview alert' },
    { command: 'lastbuy', description: 'Show the latest detected buy' },
    { command: 'config', description: 'Show current settings' },
    { command: 'enable', description: 'Enable alerts in this chat' },
    { command: 'disable', description: 'Disable alerts in this chat' },
  ]);

  const setupKeyboard = (chatId: number) => ({ inline_keyboard: [
    [
      { text: state.enabledChatIds.includes(chatId) ? '✅ Alerts Enabled' : '🔔 Enable Here', callback_data: 'bb_enable' },
      { text: '🛑 Disable Here', callback_data: 'bb_disable' },
    ],
    [{ text: '🐋 Choose Whale Alert', callback_data: 'bb_whale_menu' }],
    [{ text: '🪙 Token, Filters & Milestones', callback_data: 'bb_token_menu' }],
    [{ text: '🎨 Branding, Media & Links', callback_data: 'bb_branding' }],
    [
      { text: '📊 Stats', callback_data: 'bb_stats' },
      { text: '⚙️ Config', callback_data: 'bb_config' },
    ],
    [{ text: '👀 Preview Alert', callback_data: 'bb_preview' }],
    [{ text: '🗑 Reset Stats', callback_data: 'bb_reset_confirm' }],
  ] });

  const sendSetup = (chatId: number) => bot.sendMessage(chatId,
    `<b>⚙️ Realtime Buybot Setup</b>\n\nAlerts in this chat: <b>${state.enabledChatIds.includes(chatId) ? 'ON ✅' : 'OFF'}</b>\nToken: <code>${getChatConfig(chatId).tokenAddress || HUH_TOKEN}</code>\nWhale alert: <b>${esc(getChatConfig(chatId).whaleTiers?.whale || state.whaleThresholdWeth)} WETH</b>\n\nTap a button below:`,
    { parse_mode: 'HTML', reply_markup: setupKeyboard(chatId) });

  bot.onText(/^\/start(?:@\w+)?$/, async msg => {
    if (await isAuthorized(msg.chat, msg.from?.id)) return void sendSetup(msg.chat.id);
    bot.sendMessage(msg.chat.id, '<b>HUH Realtime Buy Bot</b>\n\nAsk the bot owner to run /setup.', { parse_mode: 'HTML' });
  });

  bot.onText(/^\/setup(?:@\w+)?$/, async msg => {
    if (!await isAuthorized(msg.chat, msg.from?.id)) return void bot.sendMessage(msg.chat.id, 'Unauthorized. Group administrators only.');
    if (!state.enabledChatIds.includes(msg.chat.id)) {
      state.enabledChatIds.push(msg.chat.id);
      saveState();
      await bot.sendMessage(msg.chat.id, `✅ Realtime ${symbol} buy alerts enabled in this chat.`);
    }
    void sendSetup(msg.chat.id);
  });

  bot.on('new_chat_members', async msg => {
    const addedThisBot = msg.new_chat_members?.some(member => member.id === me.id);
    if (!addedThisBot) return;
    if (!await isAuthorized(msg.chat, msg.from?.id)) {
      void bot.sendMessage(msg.chat.id, 'Ask a group administrator to send /setup to activate HUH buy alerts.');
      return;
    }
    if (!state.enabledChatIds.includes(msg.chat.id)) state.enabledChatIds.push(msg.chat.id);
    saveState();
    void bot.sendMessage(msg.chat.id, '✅ HUH buy alerts enabled automatically.');
    void sendSetup(msg.chat.id);
  });

  bot.on('callback_query', async query => {
    if (!query.message) return;
    const chatId = query.message.chat.id;
    if (!await isAuthorized(query.message.chat, query.from.id)) {
      await bot.answerCallbackQuery(query.id, { text: 'Group administrators only', show_alert: true });
      return;
    }

    const data = query.data || '';
    await bot.answerCallbackQuery(query.id).catch(() => {});
    if (data === 'bb_enable') {
      if (!state.enabledChatIds.includes(chatId)) state.enabledChatIds.push(chatId);
      saveState();
      await bot.sendMessage(chatId, `✅ Realtime ${symbol} buy alerts enabled here.`);
      return void sendSetup(chatId);
    }
    if (data === 'bb_disable') {
      state.enabledChatIds = state.enabledChatIds.filter(id => id !== chatId);
      saveState();
      await bot.sendMessage(chatId, '🛑 Buy alerts disabled here.');
      return void sendSetup(chatId);
    }
    if (data === 'bb_whale_menu') {
      await bot.sendMessage(chatId, '<b>🐋 Select whale threshold</b>', {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: [
          [{ text: '0.01 WETH', callback_data: 'bb_whale_0.01' }, { text: '0.05 WETH', callback_data: 'bb_whale_0.05' }],
          [{ text: '0.10 WETH', callback_data: 'bb_whale_0.10' }, { text: '0.50 WETH', callback_data: 'bb_whale_0.50' }],
          [{ text: '1.00 WETH', callback_data: 'bb_whale_1.00' }],
        ]},
      });
      return;
    }
    if (data.startsWith('bb_whale_')) {
      state.whaleThresholdWeth = data.slice('bb_whale_'.length);
      const config = getChatConfig(chatId);
      config.whaleTiers ??= { dolphin: '0.01', shark: '0.05', whale: '0.10' };
      config.whaleTiers.whale = state.whaleThresholdWeth;
      saveState();
      await bot.sendMessage(chatId, `🐋 Whale threshold set to ${state.whaleThresholdWeth} WETH.`);
      return void sendSetup(chatId);
    }
    if (data === 'bb_token_menu') {
      const config = getChatConfig(chatId);
      return void bot.sendMessage(chatId, [
        '<b>🪙 Token, Filters & Reporting</b>',
        '',
        `Token: <code>${config.tokenAddress || HUH_TOKEN}</code>`,
        `Minimum buy: <b>${esc(config.minimumBuyWeth || '0')} WETH</b>`,
        `Anti-spam window: <b>${config.antiSpamSeconds || 0}s</b>`,
        `Liquidity alerts: <b>${config.liquidityAlerts === false ? 'OFF' : 'ON'}</b>`,
        `Timezone: <b>${esc(config.timezone || 'Asia/Manila')}</b>`,
      ].join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        [{ text: '🪙 Change Token CA', callback_data: 'bb_settoken' }],
        [{ text: '🔎 Minimum Buy', callback_data: 'bb_minbuy' }, { text: '🧹 Anti-spam', callback_data: 'bb_antispam' }],
        [{ text: '🎯 MC Milestones', callback_data: 'bb_milestones' }],
        [{ text: '💧 Toggle Liquidity Alerts', callback_data: 'bb_liquidity' }],
        [{ text: '🧩 Message Template', callback_data: 'bb_template' }],
        [{ text: '🕐 Timezone', callback_data: 'bb_timezone' }, { text: '📅 Report Now', callback_data: 'bb_report' }],
        [{ text: '⬅️ Main Menu', callback_data: 'bb_main' }],
      ] } });
    }
    if (['bb_settoken', 'bb_minbuy', 'bb_antispam', 'bb_template', 'bb_timezone', 'bb_milestones'].includes(data)) {
      const actionMap: Record<string, 'token' | 'minbuy' | 'antispam' | 'template' | 'timezone' | 'milestones'> = {
        bb_settoken: 'token', bb_minbuy: 'minbuy', bb_antispam: 'antispam',
        bb_template: 'template', bb_timezone: 'timezone', bb_milestones: 'milestones',
      };
      pendingSetup.set(chatId, actionMap[data]);
      const prompts: Record<string, string> = {
        bb_settoken: 'Reply with the token contract address. The best WETH pool will be discovered and verified automatically.',
        bb_minbuy: 'Reply with the minimum WETH buy size, for example 0.005. Use 0 for every buy.',
        bb_antispam: 'Reply with the batching window in seconds (0–300). Use 0 for immediate alerts.',
        bb_template: 'Reply with a custom heading template. Available: {token} {symbol} {weth} {usd} {buyer} {mc}. Send DEFAULT to reset.',
        bb_timezone: 'Reply with an IANA timezone, for example Asia/Manila or UTC.',
        bb_milestones: 'Reply with comma-separated USD market caps, for example 100000,250000,1000000.',
      };
      return void bot.sendMessage(chatId, prompts[data], { reply_markup: { force_reply: true } });
    }
    if (data === 'bb_liquidity') {
      const config = getChatConfig(chatId);
      config.liquidityAlerts = config.liquidityAlerts === false;
      saveState();
      return void bot.sendMessage(chatId, `💧 Liquidity alerts ${config.liquidityAlerts ? 'enabled' : 'disabled'}.`);
    }
    if (data === 'bb_report') {
      return void bot.sendMessage(chatId, statsText(chatId, symbol, tokenDecimals), { parse_mode: 'HTML' });
    }
    if (data === 'bb_branding') {
      const config = getChatConfig(chatId);
      return void bot.sendMessage(chatId,
        `<b>🎨 Branding & Media</b>\n\nTitle: <b>${esc(config.title)}</b>\nEmoji: ${renderEmoji(config)}${config.customEmojiId ? ' <i>(Telegram custom)</i>' : ''}\nMedia: <b>${config.media?.type || 'none'}</b>`, {
          parse_mode: 'HTML', reply_markup: { inline_keyboard: [
            [{ text: '🖼 Add Image / GIF / Video', callback_data: 'bb_media' }],
            [{ text: '😀 Set Buy Emoji', callback_data: 'bb_emoji' }, { text: '✏️ Set Title', callback_data: 'bb_title' }],
            [{ text: '🔗 Configure Links', callback_data: 'bb_links' }],
            [{ text: '🧹 Remove Media', callback_data: 'bb_clear_media' }],
            [{ text: '👀 Preview', callback_data: 'bb_preview' }, { text: '⬅️ Main Menu', callback_data: 'bb_main' }],
          ]},
        });
    }
    if (data === 'bb_media') {
      pendingSetup.set(chatId, 'media');
      return void bot.sendMessage(chatId, 'Reply with one image, GIF, or video now. Telegram will store it for future alerts.', { reply_markup: { force_reply: true } });
    }
    if (data === 'bb_emoji') {
      pendingSetup.set(chatId, 'emoji');
      return void bot.sendMessage(chatId, 'Reply with one normal emoji or one Telegram custom emoji. Examples: 🟢 🚀 🔥\n\nFor a Premium custom emoji, send the emoji itself—not its sticker.', { reply_markup: { force_reply: true } });
    }
    if (data === 'bb_title') {
      pendingSetup.set(chatId, 'title');
      return void bot.sendMessage(chatId, 'Reply with the alert title, for example: HUH JUST GOT BOUGHT', { reply_markup: { force_reply: true } });
    }
    if (data === 'bb_links') {
      const config = getChatConfig(chatId);
      return void bot.sendMessage(chatId,
        `<b>🔗 Alert Buttons</b>\n\nWebsite: ${config.websiteUrl ? '✅' : '—'}\nChart: ${config.chartUrl ? '✅' : '—'}\nBuy: ${config.buyUrl ? '✅' : '—'}`, {
          parse_mode: 'HTML', reply_markup: { inline_keyboard: [
            [{ text: '🌐 Website URL', callback_data: 'bb_website' }],
            [{ text: '📈 Chart URL', callback_data: 'bb_chart' }],
            [{ text: '🛒 Buy URL', callback_data: 'bb_buy' }],
            [{ text: '⬅️ Main Menu', callback_data: 'bb_main' }],
          ]},
        });
    }
    if (data === 'bb_website' || data === 'bb_chart' || data === 'bb_buy') {
      pendingSetup.set(chatId, data.slice(3) as 'website' | 'chart' | 'buy');
      return void bot.sendMessage(chatId, 'Reply with the full https:// URL, or send CLEAR to remove this button.', { reply_markup: { force_reply: true } });
    }
    if (data === 'bb_clear_media') {
      delete getChatConfig(chatId).media;
      saveState();
      return void bot.sendMessage(chatId, '✅ Alert media removed.');
    }
    if (data === 'bb_preview') {
      await sendPreview(chatId);
      return;
    }
    if (data === 'bb_main') return void sendSetup(chatId);
    if (data === 'bb_stats') {
      return void bot.sendMessage(chatId, statsText(chatId, symbol, tokenDecimals), { parse_mode: 'HTML' });
    }
    if (data === 'bb_config') {
      const config = getChatConfig(chatId);
      return void bot.sendMessage(chatId, `<b>⚙️ Buybot Config</b>\nToken: <code>${config.tokenAddress || HUH_TOKEN}</code>\nPool: <code>${config.poolAddress || HUH_WETH_POOL}</code>\nMinimum buy: <b>${esc(config.minimumBuyWeth || '0')} WETH</b>\nWhale: <b>${esc(config.whaleTiers?.whale || state.whaleThresholdWeth)} WETH</b>\nThis chat: <b>${state.enabledChatIds.includes(chatId) ? 'ON' : 'OFF'}</b>`, { parse_mode: 'HTML' });
    }
    if (data === 'bb_reset_confirm') {
      return void bot.sendMessage(chatId, 'Reset all tracked buy statistics?', { reply_markup: { inline_keyboard: [[
        { text: 'Yes, reset', callback_data: 'bb_reset_yes' }, { text: 'Cancel', callback_data: 'bb_reset_no' },
      ]] } });
    }
    if (data === 'bb_reset_yes') {
      state.chatStats[String(chatId)] = defaultStats();
      saveState();
      return void bot.sendMessage(chatId, '✅ Buy statistics reset.');
    }
    if (data === 'bb_reset_no') return void bot.sendMessage(chatId, 'Reset cancelled.');
  });

  bot.on('message', async msg => {
    const action = pendingSetup.get(msg.chat.id);
    if (!action) return;
    if (!await isAuthorized(msg.chat, msg.from?.id)) return;
    const config = getChatConfig(msg.chat.id);

    if (action === 'media') {
      const photo = msg.photo?.[msg.photo.length - 1];
      if (photo) config.media = { type: 'photo', fileId: photo.file_id };
      else if (msg.animation) config.media = { type: 'animation', fileId: msg.animation.file_id };
      else if (msg.video) config.media = { type: 'video', fileId: msg.video.file_id };
      else {
        await bot.sendMessage(msg.chat.id, 'Please send an image, Telegram GIF, or video—not a document.');
        return;
      }
      pendingSetup.delete(msg.chat.id);
      saveState();
      await bot.sendMessage(msg.chat.id, `✅ ${config.media.type} saved for buy alerts.`);
      await sendPreview(msg.chat.id);
      return;
    }

    const text = msg.text?.trim();
    if (!text) {
      await bot.sendMessage(msg.chat.id, 'Please send text, or use /setup to restart configuration.');
      return;
    }
    if (action === 'token') {
      if (!isAddress(text)) {
        await bot.sendMessage(msg.chat.id, 'Invalid contract address. Send a complete 0x address.');
        return;
      }
      try {
        const resolved = await resolveToken(text as Address);
        config.tokenAddress = resolved.tokenAddress;
        config.poolAddress = resolved.poolAddress;
        config.poolFee = resolved.poolFee;
        config.tokenName = resolved.name;
        config.tokenSymbol = resolved.symbol;
        config.tokenDecimals = resolved.decimals;
        config.chartUrl = resolved.dexUrl;
        config.title = `${resolved.symbol} BUY`;
        pendingSetup.delete(msg.chat.id);
        saveState();
        await ensurePoolWatcher(resolved);
        await bot.sendMessage(msg.chat.id, `✅ ${resolved.name} (${resolved.symbol}) configured.\nPool: ${resolved.poolAddress}\nFee: ${resolved.poolFee}\nLiquidity: ${resolved.liquidityUsd === undefined ? 'not supplied' : `$${resolved.liquidityUsd.toLocaleString()}`}`);
        await sendSetup(msg.chat.id);
      } catch (error: any) {
        await bot.sendMessage(msg.chat.id, `Token setup failed: ${error?.message || error}`);
      }
      return;
    }
    if (action === 'minbuy') {
      if (!/^\d+(\.\d{1,18})?$/.test(text)) return void bot.sendMessage(msg.chat.id, 'Send a valid WETH amount, for example 0.005.');
      config.minimumBuyWeth = text;
    } else if (action === 'antispam') {
      const seconds = Number(text);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 300) return void bot.sendMessage(msg.chat.id, 'Use a whole number from 0 to 300.');
      config.antiSpamSeconds = seconds;
    } else if (action === 'template') {
      if (text.toUpperCase() === 'DEFAULT') delete config.messageTemplate;
      else if (text.length > 400) return void bot.sendMessage(msg.chat.id, 'Template must be 400 characters or fewer.');
      else config.messageTemplate = text;
    } else if (action === 'timezone') {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: text }).format();
      } catch {
        return void bot.sendMessage(msg.chat.id, 'Invalid timezone. Example: Asia/Manila');
      }
      config.timezone = text;
    } else if (action === 'milestones') {
      const milestones = text.split(',').map(value => Number(value.trim())).filter(value => Number.isFinite(value) && value > 0);
      if (!milestones.length || milestones.length > 12) return void bot.sendMessage(msg.chat.id, 'Send 1–12 positive values separated by commas.');
      config.marketCapMilestones = [...new Set(milestones)].sort((a, b) => a - b);
    } else if (action === 'emoji') {
      if (Array.from(text).length > 8) {
        await bot.sendMessage(msg.chat.id, 'Please use 1–8 emoji characters.');
        return;
      }
      config.buyEmoji = text;
      const customEntity = msg.entities?.find(entity => entity.type === 'custom_emoji') as (MessageEntity & { custom_emoji_id?: string }) | undefined;
      if (customEntity?.custom_emoji_id) config.customEmojiId = customEntity.custom_emoji_id;
      else delete config.customEmojiId;
    } else if (action === 'title') {
      if (text.length > 64) {
        await bot.sendMessage(msg.chat.id, 'Please keep the title to 64 characters or fewer.');
        return;
      }
      config.title = text;
    } else {
      const key = action === 'website' ? 'websiteUrl' : action === 'chart' ? 'chartUrl' : 'buyUrl';
      if (text.toUpperCase() === 'CLEAR') {
        delete config[key];
      } else {
        try {
          const parsed = new URL(text);
          if (parsed.protocol !== 'https:') throw new Error('HTTPS required');
          config[key] = parsed.toString();
        } catch {
          await bot.sendMessage(msg.chat.id, 'Invalid link. Send a complete https:// URL, or CLEAR.');
          return;
        }
      }
    }

    pendingSetup.delete(msg.chat.id);
    saveState();
    await bot.sendMessage(msg.chat.id, '✅ Saved.');
    await sendSetup(msg.chat.id);
  });

  bot.onText(/^\/enable(?:@\w+)?$/, async msg => {
    if (!await isAuthorized(msg.chat, msg.from?.id)) return void bot.sendMessage(msg.chat.id, 'Unauthorized. Group administrators only.');
    if (!state.enabledChatIds.includes(msg.chat.id)) state.enabledChatIds.push(msg.chat.id);
    saveState();
    bot.sendMessage(msg.chat.id, `✅ Realtime ${symbol} buy alerts enabled in this chat.`);
  });

  bot.onText(/^\/disable(?:@\w+)?$/, async msg => {
    if (!await isAuthorized(msg.chat, msg.from?.id)) return void bot.sendMessage(msg.chat.id, 'Unauthorized. Group administrators only.');
    state.enabledChatIds = state.enabledChatIds.filter(id => id !== msg.chat.id);
    saveState();
    bot.sendMessage(msg.chat.id, '🛑 Buy alerts disabled in this chat.');
  });

  bot.onText(/^\/setwhale(?:@\w+)?\s+(\S+)$/, async (msg, match) => {
    if (!await isAuthorized(msg.chat, msg.from?.id)) return void bot.sendMessage(msg.chat.id, 'Unauthorized. Group administrators only.');
    const value = match?.[1] || '';
    if (!/^\d+(\.\d{1,18})?$/.test(value) || Number(value) <= 0) {
      return void bot.sendMessage(msg.chat.id, 'Usage: /setwhale 0.10');
    }
    state.whaleThresholdWeth = value;
    const config = getChatConfig(msg.chat.id);
    config.whaleTiers ??= { dolphin: '0.01', shark: '0.05', whale: '0.10' };
    config.whaleTiers.whale = value;
    saveState();
    bot.sendMessage(msg.chat.id, `🐋 Whale threshold set to ${value} WETH.`);
  });

  bot.onText(/^\/stats(?:@\w+)?$/, msg => {
    const config = getChatConfig(msg.chat.id);
    bot.sendMessage(msg.chat.id, statsText(msg.chat.id, config.tokenSymbol || symbol, config.tokenDecimals || tokenDecimals), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/config(?:@\w+)?$/, msg => {
    const config = getChatConfig(msg.chat.id);
    bot.sendMessage(msg.chat.id,
      `<b>⚙️ Buybot Config</b>\nToken: <code>${config.tokenAddress || HUH_TOKEN}</code>\nPool: <code>${config.poolAddress || HUH_WETH_POOL}</code>\nMinimum buy: <b>${esc(config.minimumBuyWeth || '0')} WETH</b>\nWhale: <b>${esc(config.whaleTiers?.whale || state.whaleThresholdWeth)} WETH</b>\nThis chat: <b>${state.enabledChatIds.includes(msg.chat.id) ? 'ON' : 'OFF'}</b>`,
      { parse_mode: 'HTML' });
  });

  bot.onText(/^\/resetstats(?:@\w+)?$/, async msg => {
    if (!await isAuthorized(msg.chat, msg.from?.id)) return void bot.sendMessage(msg.chat.id, 'Unauthorized. Group administrators only.');
    state.chatStats[String(msg.chat.id)] = defaultStats();
    saveState();
    bot.sendMessage(msg.chat.id, '✅ Buy statistics reset.');
  });

  type AlertEvent = {
    tokenOut: bigint;
    wethIn: bigint;
    recipient: Address;
    sqrtPriceX96: bigint;
    txHash: Hex;
    blockNumber?: bigint;
    batchCount?: number;
  };
  const watcherStops = new Map<string, Array<() => void>>();
  const seenLogs = new Set<string>();
  const dexCaches = new Map<string, { value?: DexMarket; fetchedAt: number }>();
  const batchBuffers = new Map<number, { resolved: ResolvedToken; events: AlertEvent[]; timer: NodeJS.Timeout }>();

  function chatsForPool(poolAddress: Address): number[] {
    return state.enabledChatIds.filter(chatId => {
      const configured = getChatConfig(chatId).poolAddress || HUH_WETH_POOL;
      return configured.toLowerCase() === poolAddress.toLowerCase();
    });
  }

  async function dexFor(resolved: ResolvedToken): Promise<DexMarket | undefined> {
    const key = resolved.poolAddress.toLowerCase();
    const cached = dexCaches.get(key) || { fetchedAt: 0 };
    if (Date.now() - cached.fetchedAt < 5_000) return cached.value;
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${resolved.poolAddress}`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { pairs?: DexMarket[] };
      const next = { value: payload.pairs?.[0], fetchedAt: Date.now() };
      dexCaches.set(key, next);
      return next.value;
    } catch (error: any) {
      console.error(`[buybot dexscreener ${short(resolved.poolAddress)}] ${error?.message || error}`);
      dexCaches.set(key, { ...cached, fetchedAt: Date.now() });
      return cached.value;
    }
  }

  function fallbackMarket(resolved: ResolvedToken, sqrtPriceX96: bigint) {
    const squared = sqrtPriceX96 * sqrtPriceX96;
    const q192 = 1n << 192n;
    const oneToken = 10n ** BigInt(resolved.decimals);
    const priceWethWei = resolved.tokenIs0 ? (squared * oneToken) / q192 : (q192 * oneToken) / squared;
    return {
      priceWeth: formatUnits(priceWethWei, 18),
      marketCapWeth: formatUnits((priceWethWei * resolved.totalSupply) / oneToken, 18),
    };
  }

  async function deliverBuyAlert(chatId: number, resolved: ResolvedToken, event: AlertEvent): Promise<void> {
    const config = getChatConfig(chatId);
    const dex = await dexFor(resolved);
    const wethFormatted = formatUnits(event.wethIn, 18);
    const tokenFormatted = formatUnits(event.tokenOut, resolved.decimals);
    const tiers = config.whaleTiers || { dolphin: '0.01', shark: '0.05', whale: state.whaleThresholdWeth };
    const tier = event.wethIn >= parseUnits(tiers.whale, 18) ? 'WHALE'
      : event.wethIn >= parseUnits(tiers.shark, 18) ? 'SHARK'
      : event.wethIn >= parseUnits(tiers.dolphin, 18) ? 'DOLPHIN' : 'BUY';
    const threshold = Math.max(Number(tiers.whale), 0.000001);
    const emojiCount = Math.min(12, Math.max(2, Math.ceil(Number(wethFormatted) / (threshold / 4))));
    const emojiBar = Array(emojiCount).fill(renderEmoji(config)).join('');
    const dexMarketCap = dex?.marketCap ?? dex?.fdv;
    const wethUsd = dex?.priceUsd && dex?.priceNative && Number(dex.priceNative) > 0
      ? Number(dex.priceUsd) / Number(dex.priceNative) : undefined;
    const buyUsd = wethUsd === undefined ? undefined : Number(wethFormatted) * wethUsd;
    const templateValues: Record<string, string> = {
      token: resolved.name, symbol: resolved.symbol, weth: wethFormatted,
      usd: buyUsd === undefined ? 'N/A' : compactUsd(buyUsd), buyer: short(event.recipient),
      mc: dexMarketCap === undefined ? 'N/A' : compactUsd(dexMarketCap),
    };
    const customHeading = config.messageTemplate
      ? Object.entries(templateValues).reduce((value, [key, replacement]) => value.replaceAll(`{${key}}`, esc(replacement)), esc(config.messageTemplate))
      : undefined;
    const heading = customHeading
      ? `${emojiBar}\n<b>${customHeading}</b>\n${emojiBar}`
      : tier === 'WHALE'
        ? `🐋🚨 <b>WHALE ${esc(config.title)}</b> 🚨🐋\n${emojiBar}`
        : `${emojiBar}\n${tier === 'SHARK' ? '🦈' : tier === 'DOLPHIN' ? '🐬' : '🔥'} <b>${esc(config.title)}</b> ${tier === 'SHARK' ? '🦈' : tier === 'DOLPHIN' ? '🐬' : '🔥'}\n${emojiBar}`;
    const fallback = fallbackMarket(resolved, event.sqrtPriceX96);
    const marketLines = dex?.priceUsd && dexMarketCap !== undefined ? [
      `💵 Price       <b>$${compact(dex.priceUsd, 10)}</b>`,
      `💎 Market Cap  <b>${compactUsd(dexMarketCap)}</b>`,
      ...(dex.liquidity?.usd !== undefined ? [`💧 Liquidity   <b>${compactUsd(dex.liquidity.usd)}</b>`] : []),
      ...(dex.volume?.h24 !== undefined ? [`📊 Volume 24h  <b>${compactUsd(dex.volume.h24)}</b>`] : []),
      ...(dex.priceChange?.h24 !== undefined ? [`${dex.priceChange.h24 >= 0 ? '📈' : '📉'} Change 24h  <b>${dex.priceChange.h24 >= 0 ? '+' : ''}${dex.priceChange.h24}%</b>`] : []),
    ] : [`💵 Price       <b>${compact(fallback.priceWeth, 10)} WETH</b>`, `💎 FDV         <b>${compact(fallback.marketCapWeth, 2)} WETH</b>`];
    const html = [
      heading, '',
      `<blockquote><b>💸 ${event.batchCount && event.batchCount > 1 ? `${event.batchCount} BUYS COMBINED` : 'BUY DETAILS'}</b>\n💰 Spent       <b>${compact(wethFormatted)} WETH</b>${buyUsd === undefined ? '' : `\n💵 Value       <b>${compactUsd(buyUsd)}</b>`}\n🪙 Received    <b>${compact(tokenFormatted, 2)} ${esc(resolved.symbol)}</b></blockquote>`,
      `<b>📊 ${esc(resolved.name.toUpperCase())} MARKET</b>`, ...marketLines, '',
      `👤 Buyer  <a href="${EXPLORER}/address/${event.recipient}">${short(event.recipient)}</a>`,
      `📄 CA     <code>${resolved.tokenAddress}</code>`, '', '<i>⚡ Live on Robinhood Chain</i>',
    ].join('\n');
    await sendRichAlert(chatId, html, event.txHash);

    if (dexMarketCap !== undefined) {
      const milestones = (config.marketCapMilestones || [100_000, 250_000, 500_000, 1_000_000]).filter(value => value <= dexMarketCap);
      const reached = milestones.length ? Math.max(...milestones) : undefined;
      if (reached !== undefined && config.lastMarketCapMilestone === undefined) config.lastMarketCapMilestone = reached;
      else if (reached !== undefined && reached > (config.lastMarketCapMilestone || 0)) {
        config.lastMarketCapMilestone = reached;
        await bot.sendMessage(chatId, `🎯 <b>${esc(resolved.symbol)} MARKET-CAP MILESTONE</b>\n\n${compactUsd(reached)} reached 🚀`, { parse_mode: 'HTML' });
      }
      saveState();
    }
  }

  async function queueBuyAlert(chatId: number, resolved: ResolvedToken, event: AlertEvent): Promise<void> {
    const windowSeconds = getChatConfig(chatId).antiSpamSeconds || 0;
    if (!windowSeconds) return deliverBuyAlert(chatId, resolved, event);
    const existing = batchBuffers.get(chatId);
    if (existing) {
      existing.events.push(event);
      return;
    }
    const timer = setTimeout(async () => {
      const batch = batchBuffers.get(chatId);
      batchBuffers.delete(chatId);
      if (!batch?.events.length) return;
      const last = batch.events[batch.events.length - 1];
      const combined: AlertEvent = {
        ...last,
        wethIn: batch.events.reduce((sum, item) => sum + item.wethIn, 0n),
        tokenOut: batch.events.reduce((sum, item) => sum + item.tokenOut, 0n),
        batchCount: batch.events.length,
      };
      await deliverBuyAlert(chatId, batch.resolved, combined).catch(error => console.error(`[buybot batch] ${error.message}`));
    }, windowSeconds * 1_000);
    batchBuffers.set(chatId, { resolved, events: [event], timer });
  }

  async function ensurePoolWatcher(resolved: ResolvedToken): Promise<void> {
    const key = resolved.poolAddress.toLowerCase();
    if (watcherStops.has(key)) return;
    const swapStop = publicClient.watchContractEvent({
      address: resolved.poolAddress, abi: POOL_ABI, eventName: 'Swap', pollingInterval: 2_000,
      onLogs: async logs => {
        for (const log of logs) {
          const dedupeKey = `${log.transactionHash}:${log.logIndex}`;
          if (seenLogs.has(dedupeKey)) continue;
          seenLogs.add(dedupeKey);
          if (seenLogs.size > 10_000) seenLogs.clear();
          const { amount0, amount1, recipient, sqrtPriceX96 } = log.args;
          if (amount0 === undefined || amount1 === undefined || sqrtPriceX96 === undefined || !recipient || !log.transactionHash) continue;
          const tokenDelta = resolved.tokenIs0 ? amount0 : amount1;
          const wethDelta = resolved.tokenIs0 ? amount1 : amount0;
          if (tokenDelta >= 0n || wethDelta <= 0n) continue;
          const event: AlertEvent = { tokenOut: -tokenDelta, wethIn: wethDelta, recipient, sqrtPriceX96, txHash: log.transactionHash, blockNumber: log.blockNumber };
          await Promise.allSettled(chatsForPool(resolved.poolAddress).map(async chatId => {
            const config = getChatConfig(chatId);
            if (event.wethIn < parseUnits(config.minimumBuyWeth || '0', 18)) return;
            const stats = getChatStats(chatId);
            const buyer = event.recipient.toLowerCase();
            stats.buys++;
            stats.totalWethWei = (BigInt(stats.totalWethWei) + event.wethIn).toString();
            stats.totalTokenRaw = (BigInt(stats.totalTokenRaw) + event.tokenOut).toString();
            if (!stats.buyers.includes(buyer)) stats.buyers.push(buyer);
            const buyerMilestone = Math.max(0, ...(config.buyerMilestones || [100, 250, 500, 1_000]).filter(value => value <= stats.buyers.length));
            if (buyerMilestone > (config.lastBuyerMilestone || 0)) {
              config.lastBuyerMilestone = buyerMilestone;
              bot.sendMessage(chatId, `👥 ${resolved.symbol} buyer milestone: ${buyerMilestone.toLocaleString()} unique buyers tracked!`).catch(() => {});
            }
            if (event.wethIn > BigInt(stats.largestWethWei)) {
              stats.largestWethWei = event.wethIn.toString();
              stats.largestTxHash = event.txHash;
            }
            stats.lastBuyTxHash = event.txHash;
            stats.lastBuyAt = new Date().toISOString();
            if (event.blockNumber !== undefined) stats.lastScannedBlock = event.blockNumber.toString();
            saveState();
            await queueBuyAlert(chatId, resolved, event);
          }));
        }
      },
      onError: error => console.error(`[buybot watcher ${short(resolved.poolAddress)}] ${error.message}`),
    });
    const liquidityStops = (['Mint', 'Burn'] as const).map(eventName => publicClient.watchContractEvent({
      address: resolved.poolAddress, abi: POOL_ABI, eventName, pollingInterval: 4_000,
      onLogs: async logs => {
        if (!logs.length) return;
        await Promise.allSettled(chatsForPool(resolved.poolAddress).filter(chatId => getChatConfig(chatId).liquidityAlerts !== false).map(chatId =>
          bot.sendMessage(chatId, `${eventName === 'Mint' ? '💧 LIQUIDITY ADDED' : '⚠️ LIQUIDITY REMOVED'}\n${resolved.symbol}/WETH\nTransactions: ${logs.length}\n${EXPLORER}/tx/${logs[logs.length - 1].transactionHash}`),
        ));
      },
      onError: error => console.error(`[buybot liquidity ${short(resolved.poolAddress)}] ${error.message}`),
    }));
    watcherStops.set(key, [swapStop, ...liquidityStops]);
    console.log(`Buybot watcher active | ${resolved.symbol} | ${resolved.poolAddress} | chats ${chatsForPool(resolved.poolAddress).length}`);
  }

  bot.onText(/^\/health(?:@\w+)?$/, async msg => {
    const config = getChatConfig(msg.chat.id);
    const stats = getChatStats(msg.chat.id);
    try {
      const started = Date.now();
      const block = await publicClient.getBlockNumber();
      bot.sendMessage(msg.chat.id, `🩺 BUYBOT HEALTH\nRPC: ONLINE (${Date.now() - started}ms)\nBlock: ${block}\nWatcher: ${watcherStops.has((config.poolAddress || HUH_WETH_POOL).toLowerCase()) ? 'ACTIVE' : 'STARTING'}\nLast scanned: ${stats.lastScannedBlock || 'waiting'}\nLast buy: ${stats.lastBuyAt || 'none'}\nAlerts here: ${state.enabledChatIds.includes(msg.chat.id) ? 'ON' : 'OFF'}`);
    } catch (error: any) {
      bot.sendMessage(msg.chat.id, `⚠️ BUYBOT HEALTH DEGRADED\n${error?.message || error}`);
    }
  });
  bot.onText(/^\/testalert(?:@\w+)?$/, async msg => {
    if (!await isAuthorized(msg.chat, msg.from?.id)) return void bot.sendMessage(msg.chat.id, 'Group administrators only.');
    await sendPreview(msg.chat.id);
  });
  bot.onText(/^\/lastbuy(?:@\w+)?$/, msg => {
    const stats = getChatStats(msg.chat.id);
    bot.sendMessage(msg.chat.id, stats.lastBuyTxHash
      ? `🟢 Last buy: ${stats.lastBuyAt}\n${EXPLORER}/tx/${stats.lastBuyTxHash}`
      : 'No qualifying buy has been detected for this chat yet.');
  });

  const defaultResolved: ResolvedToken = {
    tokenAddress: HUH_TOKEN, poolAddress: HUH_WETH_POOL, poolFee: 10_000,
    token0, token1, tokenIs0: huhIsToken0, name: tokenName, symbol,
    decimals: tokenDecimals, totalSupply, dexUrl: DEXSCREENER_URL,
  };
  await ensurePoolWatcher(defaultResolved);
  const configuredPools = new Map<string, { token: Address; pool: Address }>();
  for (const chatId of state.enabledChatIds) {
    const config = getChatConfig(chatId);
    if (config.tokenAddress && config.poolAddress && config.poolAddress.toLowerCase() !== HUH_WETH_POOL.toLowerCase()) {
      configuredPools.set(config.poolAddress.toLowerCase(), { token: config.tokenAddress, pool: config.poolAddress });
    }
  }
  for (const configured of configuredPools.values()) {
    try { await ensurePoolWatcher(await resolveToken(configured.token, configured.pool)); }
    catch (error: any) { console.error(`[buybot restore] ${error?.message || error}`); }
  }

  setInterval(() => {
    for (const chatId of state.enabledChatIds) {
      const config = getChatConfig(chatId);
      const now = new Date();
      const localHour = Number(new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: config.timezone || 'Asia/Manila' }).format(now));
      const key = `${now.toISOString().slice(0, 10)}:${chatId}`;
      const stats = getChatStats(chatId) as BuyStats & { lastDailyReportKey?: string };
      if (localHour === 9 && stats.lastDailyReportKey !== key) {
        stats.lastDailyReportKey = key;
        bot.sendMessage(chatId, statsText(chatId, config.tokenSymbol || symbol, config.tokenDecimals || tokenDecimals), { parse_mode: 'HTML' }).catch(() => {});
      }
    }
    saveState();
  }, 15 * 60_000).unref();

  console.log(`Realtime buybot running | watchers ${watcherStops.size} | alerts ${state.enabledChatIds.length}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
