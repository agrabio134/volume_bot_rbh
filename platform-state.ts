import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type PersistedWallet = { privateKey: string };

export type PersistedSession = {
  tokenCA: string;
  poolAddress?: string;
  poolVersion?: 'v3' | 'v4';
  poolFee?: number;
  poolTickSpacing?: number;
  poolCurrency0?: string;
  poolCurrency1?: string;
  poolHooks?: string;
  running: boolean;
  paused: boolean;
  package: string;
  mode: 'volume' | 'bump';
  durationMs: number;
  wallets: PersistedWallet[];
  startTime: number;
  endTime: number;
  orderId: string;
  completedBuys: number;
  completedSells: number;
  failedSwaps: number;
  lastActivityAt: number;
  dailyBuyWei?: string;
  dailyWindowStartedAt?: number;
  setupStatus?: 'funding' | 'ready';
  fundingTargetWei?: string;
};

export type PaymentOrder = {
  id: string;
  chatId: number;
  tokenCA: string;
  package: string;
  mode: 'volume' | 'bump';
  durationMs: number;
  expectedWei: string;
  createdAt: number;
  createdBlock: string;
  status: 'pending' | 'verifying' | 'paid' | 'running' | 'completed' | 'failed' | 'expired';
  paymentTxHash?: string;
  submittedPaymentTxHash?: string;
  lastScannedBlock?: string;
  verificationStartedAt?: number;
  commissionTxHash?: string;
  failureReason?: string;
  completedAt?: number;
  promoCode?: string;
  referrerChatId?: number;
  remindersSent?: string[];
  poolAddress?: string;
  poolVersion?: 'v3' | 'v4';
  poolFee?: number;
  poolTickSpacing?: number;
  poolCurrency0?: string;
  poolCurrency1?: string;
  poolHooks?: string;
};

export type SupportTicket = {
  id: string;
  chatId: number;
  text: string;
  createdAt: number;
  status: 'open' | 'closed';
};

export type UserPreference = {
  language: 'en' | 'fil';
  timezone: string;
  promoCode?: string;
  referredBy?: number;
  referralUses: number;
};

export type PlatformState = {
  version: 2;
  sessions: Record<string, PersistedSession>;
  orders: PaymentOrder[];
  tickets: SupportTicket[];
  users: Record<string, UserPreference>;
  claimedPaymentTxHashes: string[];
  startedAt: number;
};

const defaults = (): PlatformState => ({
  version: 2,
  sessions: {},
  orders: [],
  tickets: [],
  users: {},
  claimedPaymentTxHashes: [],
  startedAt: Date.now(),
});

function encryptionKey(): Buffer {
  const secret = process.env.DATA_ENCRYPTION_KEY || process.env.PRIVATE_KEY || process.env.BOT_TOKEN;
  if (!secret) throw new Error('DATA_ENCRYPTION_KEY, PRIVATE_KEY, or BOT_TOKEN is required for encrypted state');
  return crypto.createHash('sha256').update(`rbh-bot-state:${secret}`).digest();
}

function seal(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  });
}

function open(payload: string): string {
  const parsed = JSON.parse(payload) as { version: number; iv: string; tag: string; data: string };
  if (parsed.version !== 1) throw new Error('Unsupported encrypted state version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export class PlatformStateStore {
  private readonly file: string;
  private readonly backupFolder: string;
  private state: PlatformState;
  private lastBackupAt = 0;

  constructor(dataFolder: string) {
    this.file = path.join(dataFolder, 'platform-state.enc');
    this.backupFolder = path.join(dataFolder, 'backups');
    fs.mkdirSync(dataFolder, { recursive: true });
    fs.mkdirSync(this.backupFolder, { recursive: true });
    this.state = this.load();
  }

  get(): PlatformState {
    return this.state;
  }

  save(): void {
    if (fs.existsSync(this.file) && Date.now() - this.lastBackupAt > 6 * 60 * 60 * 1000) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(this.file, path.join(this.backupFolder, `platform-${stamp}.enc`));
      this.lastBackupAt = Date.now();
      this.pruneBackups(12);
    }
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, seal(JSON.stringify(this.state)), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  exportBackup(): string {
    this.save();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(this.backupFolder, `manual-${stamp}.enc`);
    fs.copyFileSync(this.file, destination);
    return destination;
  }

  private load(): PlatformState {
    try {
      const saved = JSON.parse(open(fs.readFileSync(this.file, 'utf8'))) as Partial<PlatformState>;
      const base = defaults();
      return {
        ...base,
        ...saved,
        version: 2,
        sessions: saved.sessions || {},
        orders: saved.orders || [],
        tickets: saved.tickets || [],
        users: saved.users || {},
        claimedPaymentTxHashes: saved.claimedPaymentTxHashes || [],
      };
    } catch {
      return defaults();
    }
  }

  private pruneBackups(keep: number): void {
    const backups = fs.readdirSync(this.backupFolder)
      .filter(name => name.endsWith('.enc'))
      .map(name => ({ name, modified: fs.statSync(path.join(this.backupFolder, name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified);
    for (const old of backups.slice(keep)) fs.unlinkSync(path.join(this.backupFolder, old.name));
  }
}

export function encryptWalletKeys(privateKeys: string[]): string {
  return seal(JSON.stringify(privateKeys));
}

export function decryptWalletKeys(payload: string): string[] {
  const parsed = JSON.parse(open(payload));
  return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [];
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export class SlidingWindowRateLimiter {
  private readonly events = new Map<number, number[]>();

  allow(id: number, maximum = 10, windowMs = 10_000): boolean {
    const cutoff = Date.now() - windowMs;
    const recent = (this.events.get(id) || []).filter(timestamp => timestamp >= cutoff);
    if (recent.length >= maximum) {
      this.events.set(id, recent);
      return false;
    }
    recent.push(Date.now());
    this.events.set(id, recent);
    return true;
  }
}

export function defaultUserPreference(): UserPreference {
  return { language: 'en', timezone: 'Asia/Manila', referralUses: 0 };
}
