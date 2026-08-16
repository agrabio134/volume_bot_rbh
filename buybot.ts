import TelegramBot from 'node-telegram-bot-api';
import {
  createPublicClient, formatUnits, http, parseUnits, type Address, type Hex,
} from 'viem';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {
  robinhood, HUH_TOKEN, WETH_TOKEN, HUH_WETH_POOL, getRpcUrl,
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
};

type BuybotState = {
  enabledChatIds: number[];
  whaleThresholdWeth: string;
  chatConfigs: Record<string, ChatConfig>;
  stats: {
    buys: number;
    totalWethWei: string;
    totalTokenRaw: string;
    largestWethWei: string;
    largestTxHash?: Hex;
    buyers: string[];
    startedAt: string;
  };
};

const defaultState = (): BuybotState => ({
  enabledChatIds: [],
  whaleThresholdWeth: '0.10',
  chatConfigs: {},
  stats: {
    buys: 0,
    totalWethWei: '0',
    totalTokenRaw: '0',
    largestWethWei: '0',
    buyers: [],
    startedAt: new Date().toISOString(),
  },
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
    };
  } catch {
    return defaultState();
  }
}

let state = loadState();
const pendingSetup = new Map<number, 'media' | 'emoji' | 'title' | 'website' | 'chart' | 'buy'>();

function getChatConfig(chatId: number): ChatConfig {
  const key = String(chatId);
  state.chatConfigs[key] ??= { title: 'HUH BUY', buyEmoji: '🟢' };
  return state.chatConfigs[key];
}

function saveState() {
  fs.mkdirSync(DATA_FOLDER, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const publicClient = createPublicClient({ chain: robinhood, transport: http(getRpcUrl()) });
const bot = new TelegramBot(BUYBOT_TOKEN, { polling: true });

const POOL_ABI = [
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
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
] as const;

const ERC20_ABI = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

async function isAuthorized(chat: TelegramBot.Chat, userId?: number): Promise<boolean> {
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

function statsText(symbol: string, tokenDecimals: number): string {
  const totalWeth = formatUnits(BigInt(state.stats.totalWethWei), 18);
  const totalToken = formatUnits(BigInt(state.stats.totalTokenRaw), tokenDecimals);
  const largest = formatUnits(BigInt(state.stats.largestWethWei), 18);
  const uptimeMs = Date.now() - new Date(state.stats.startedAt).getTime();
  const hours = Math.floor(uptimeMs / 3_600_000);
  const minutes = Math.floor((uptimeMs % 3_600_000) / 60_000);
  return [
    `📊 <b>${esc(symbol)} BUYBOT STATS</b>`,
    '━━━━━━━━━━━━━━',
    `<blockquote>🟢 Total buys      <b>${state.stats.buys}</b>\n💰 Buy volume     <b>${compact(totalWeth)} WETH</b>\n🪙 Tokens bought  <b>${compact(totalToken, 2)} ${esc(symbol)}</b>\n👥 Unique buyers  <b>${state.stats.buyers.length}</b>\n🐋 Largest buy    <b>${compact(largest)} WETH</b></blockquote>`,
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
      disable_web_page_preview: true,
      reply_markup: alertButtons(chatId, txHash),
    };
    try {
      if (config.media?.type === 'photo') return await bot.sendPhoto(chatId, config.media.fileId, { ...options, caption: html });
      if (config.media?.type === 'animation') return await bot.sendAnimation(chatId, config.media.fileId, { ...options, caption: html });
      if (config.media?.type === 'video') return await bot.sendVideo(chatId, config.media.fileId, { ...options, caption: html });
      return await bot.sendMessage(chatId, html, options);
    } catch (error: any) {
      console.error(`[buybot media] ${error?.message || error}`);
      const plainEmojiHtml = html.replace(/<tg-emoji emoji-id="\d+">([\s\S]*?)<\/tg-emoji>/g, '$1');
      return bot.sendMessage(chatId, plainEmojiHtml, { parse_mode: 'HTML', disable_web_page_preview: true });
    }
  }

  async function sendPreview(chatId: number) {
    const config = getChatConfig(chatId);
    const emoji = renderEmoji(config);
    const html = [
      `${emoji}${emoji}${emoji}${emoji}${emoji}${emoji}`,
      `🔥 <b>${esc(config.title)}</b> 🔥`,
      `${emoji}${emoji}${emoji}${emoji}${emoji}${emoji}`,
      '',
      `<blockquote><b>💸 BUY DETAILS</b>\n💰 Spent: <b>0.123 WETH</b>\n💵 Value: <b>$232.50</b>\n🪙 Received: <b>12,345 ${esc(symbol)}</b></blockquote>`,
      `<b>📊 ${esc(tokenName)} MARKET</b>`,
      '💵 DEX price: <b>$0.0002672</b>',
      '📊 DEX market cap: <b>$267,219</b>',
      '💧 Liquidity: <b>$50,000</b>',
      '📈 24h volume: <b>$25,000</b>',
      '',
      `👤 <a href="${EXPLORER}/address/${HUH_TOKEN}">0x1234…5678</a>`,
      `📄 CA: <code>${HUH_TOKEN}</code>`,
      '<i>Preview — no transaction occurred</i>',
    ].join('\n');
    await sendRichAlert(chatId, html);
  }

  await bot.setMyCommands([
    { command: 'setup', description: 'Open the easy setup menu' },
    { command: 'stats', description: 'Show buy statistics' },
    { command: 'config', description: 'Show current settings' },
    { command: 'enable', description: 'Enable alerts in this chat' },
    { command: 'disable', description: 'Disable alerts in this chat' },
  ]);

  const setupKeyboard = () => ({ inline_keyboard: [
    [
      { text: state.enabledChatIds.length ? '✅ Enable Here' : '🔔 Enable Here', callback_data: 'bb_enable' },
      { text: '🛑 Disable Here', callback_data: 'bb_disable' },
    ],
    [{ text: '🐋 Choose Whale Alert', callback_data: 'bb_whale_menu' }],
    [{ text: '🎨 Branding, Media & Links', callback_data: 'bb_branding' }],
    [
      { text: '📊 Stats', callback_data: 'bb_stats' },
      { text: '⚙️ Config', callback_data: 'bb_config' },
    ],
    [{ text: '👀 Preview Alert', callback_data: 'bb_preview' }],
    [{ text: '🗑 Reset Stats', callback_data: 'bb_reset_confirm' }],
  ] });

  const sendSetup = (chatId: number) => bot.sendMessage(chatId,
    `<b>⚙️ HUH Buybot Setup</b>\n\nAlerts in this chat: <b>${state.enabledChatIds.includes(chatId) ? 'ON ✅' : 'OFF'}</b>\nWhale alert: <b>${esc(state.whaleThresholdWeth)} WETH</b>\n\nTap a button below:`,
    { parse_mode: 'HTML', reply_markup: setupKeyboard() });

  bot.onText(/^\/start(?:@\w+)?$/, async msg => {
    if (await isAuthorized(msg.chat, msg.from?.id)) return void sendSetup(msg.chat.id);
    bot.sendMessage(msg.chat.id, '<b>HUH Realtime Buy Bot</b>\n\nAsk the bot owner to run /setup.', { parse_mode: 'HTML' });
  });

  bot.onText(/^\/setup(?:@\w+)?$/, async msg => {
    if (!await isAuthorized(msg.chat, msg.from?.id)) return void bot.sendMessage(msg.chat.id, 'Unauthorized. Group administrators only.');
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
      saveState();
      await bot.sendMessage(chatId, `🐋 Whale threshold set to ${state.whaleThresholdWeth} WETH.`);
      return void sendSetup(chatId);
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
      return void bot.sendMessage(chatId, statsText(symbol, tokenDecimals), { parse_mode: 'HTML' });
    }
    if (data === 'bb_config') {
      return void bot.sendMessage(chatId, `<b>⚙️ Buybot Config</b>\nToken: <code>${HUH_TOKEN}</code>\nPool: <code>${HUH_WETH_POOL}</code>\nWhale: <b>${esc(state.whaleThresholdWeth)} WETH</b>\nThis chat: <b>${state.enabledChatIds.includes(chatId) ? 'ON' : 'OFF'}</b>`, { parse_mode: 'HTML' });
    }
    if (data === 'bb_reset_confirm') {
      return void bot.sendMessage(chatId, 'Reset all tracked buy statistics?', { reply_markup: { inline_keyboard: [[
        { text: 'Yes, reset', callback_data: 'bb_reset_yes' }, { text: 'Cancel', callback_data: 'bb_reset_no' },
      ]] } });
    }
    if (data === 'bb_reset_yes') {
      state.stats = defaultState().stats;
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
    if (action === 'emoji') {
      if (Array.from(text).length > 8) {
        await bot.sendMessage(msg.chat.id, 'Please use 1–8 emoji characters.');
        return;
      }
      config.buyEmoji = text;
      const customEntity = msg.entities?.find(entity => entity.type === 'custom_emoji') as (TelegramBot.MessageEntity & { custom_emoji_id?: string }) | undefined;
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
    saveState();
    bot.sendMessage(msg.chat.id, `🐋 Whale threshold set to ${value} WETH.`);
  });

  bot.onText(/^\/stats(?:@\w+)?$/, msg => {
    bot.sendMessage(msg.chat.id, statsText(symbol, tokenDecimals), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/config(?:@\w+)?$/, msg => {
    bot.sendMessage(msg.chat.id,
      `<b>⚙️ Buybot Config</b>\nToken: <code>${HUH_TOKEN}</code>\nPool: <code>${HUH_WETH_POOL}</code>\nWhale: <b>${esc(state.whaleThresholdWeth)} WETH</b>\nAlert chats: <b>${state.enabledChatIds.length}</b>`,
      { parse_mode: 'HTML' });
  });

  bot.onText(/^\/resetstats(?:@\w+)?$/, async msg => {
    if (!await isAuthorized(msg.chat, msg.from?.id)) return void bot.sendMessage(msg.chat.id, 'Unauthorized. Group administrators only.');
    state.stats = defaultState().stats;
    saveState();
    bot.sendMessage(msg.chat.id, '✅ Buy statistics reset.');
  });

  publicClient.watchContractEvent({
    address: HUH_WETH_POOL,
    abi: POOL_ABI,
    eventName: 'Swap',
    pollingInterval: 2_000,
    onLogs: async logs => {
      for (const log of logs) {
        const { amount0, amount1, recipient, sqrtPriceX96 } = log.args;
        if (amount0 === undefined || amount1 === undefined || sqrtPriceX96 === undefined || !recipient || !log.transactionHash) continue;

        const huhDelta = huhIsToken0 ? amount0 : amount1;
        const wethDelta = huhIsToken0 ? amount1 : amount0;
        // V3 pool deltas are from the pool's perspective: a buy sends HUH out
        // (negative HUH) and receives WETH (positive WETH).
        if (huhDelta >= 0n || wethDelta <= 0n) continue;

        const tokenOut = -huhDelta;
        const wethIn = wethDelta;
        const txHash = log.transactionHash;
        const whaleWei = parseUnits(state.whaleThresholdWeth, 18);
        const isWhale = wethIn >= whaleWei;
        const buyer = (recipient as Address).toLowerCase();
        const market = marketData(sqrtPriceX96);
        const dex = await getDexMarket();

        state.stats.buys++;
        state.stats.totalWethWei = (BigInt(state.stats.totalWethWei) + wethIn).toString();
        state.stats.totalTokenRaw = (BigInt(state.stats.totalTokenRaw) + tokenOut).toString();
        if (!state.stats.buyers.includes(buyer)) state.stats.buyers.push(buyer);
        if (wethIn > BigInt(state.stats.largestWethWei)) {
          state.stats.largestWethWei = wethIn.toString();
          state.stats.largestTxHash = txHash;
        }
        saveState();

        const wethFormatted = formatUnits(wethIn, 18);
        const tokenFormatted = formatUnits(tokenOut, tokenDecimals);
        await Promise.allSettled(state.enabledChatIds.map(async chatId => {
          const config = getChatConfig(chatId);
          const threshold = Math.max(Number(state.whaleThresholdWeth), 0.000001);
          const emojiCount = Math.min(12, Math.max(2, Math.ceil(Number(wethFormatted) / (threshold / 4))));
          const emoji = renderEmoji(config);
          const emojiBar = Array(emojiCount).fill(emoji).join('');
          const heading = isWhale
            ? `🐋🚨 <b>WHALE ${esc(config.title)}</b> 🚨🐋\n${emojiBar}`
            : `${emojiBar}\n🔥 <b>${esc(config.title)}</b> 🔥\n${emojiBar}`;
          const dexMarketCap = dex?.marketCap ?? dex?.fdv;
          const wethUsd = dex?.priceUsd && dex?.priceNative && Number(dex.priceNative) > 0
            ? Number(dex.priceUsd) / Number(dex.priceNative)
            : undefined;
          const buyUsd = wethUsd === undefined ? undefined : Number(wethFormatted) * wethUsd;
          const marketLines = dex?.priceUsd && dexMarketCap !== undefined
            ? [
                `💵 Price       <b>$${compact(dex.priceUsd, 10)}</b>`,
                `💎 Market Cap  <b>${compactUsd(dexMarketCap)}</b>`,
                ...(dex.liquidity?.usd !== undefined ? [`💧 Liquidity   <b>${compactUsd(dex.liquidity.usd)}</b>`] : []),
                ...(dex.volume?.h24 !== undefined ? [`📊 Volume 24h  <b>${compactUsd(dex.volume.h24)}</b>`] : []),
                ...(dex.priceChange?.h24 !== undefined ? [`${dex.priceChange.h24 >= 0 ? '📈' : '📉'} Change 24h  <b>${dex.priceChange.h24 >= 0 ? '+' : ''}${dex.priceChange.h24}%</b>`] : []),
              ]
            : [
                `💵 Price       <b>${compact(market.priceWeth, 10)} WETH</b>`,
                `💎 FDV         <b>${compact(market.marketCapWeth, 2)} WETH</b>`,
              ];
          const html = [
            heading,
            '',
            `<blockquote><b>💸 BUY DETAILS</b>\n💰 Spent       <b>${compact(wethFormatted)} WETH</b>${buyUsd === undefined ? '' : `\n💵 Value       <b>${compactUsd(buyUsd)}</b>`}\n🪙 Received    <b>${compact(tokenFormatted, 2)} ${esc(symbol)}</b></blockquote>`,
            `<b>📊 ${esc(tokenName.toUpperCase())} MARKET</b>`,
            ...marketLines,
            '',
            `👤 Buyer  <a href="${EXPLORER}/address/${recipient}">${short(recipient)}</a>`,
            `📄 CA     <code>${HUH_TOKEN}</code>`,
            '',
            `<i>⚡ Live on Robinhood Chain</i>`,
          ].join('\n');
          await sendRichAlert(chatId, html, txHash);
        }));
      }
    },
    onError: error => console.error(`[buybot watcher] ${error.message}`),
  });

  console.log(`HUH buybot running | pool ${HUH_WETH_POOL} | token0 ${token0} | alerts ${state.enabledChatIds.length}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
