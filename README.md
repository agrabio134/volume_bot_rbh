# Robinhood Chain Telegram Bots

One Render background worker runs two Telegram bots:

- Volume/order bot with persistent orders, encrypted wallet state, payment receipts, restart recovery and safety checks.
- Realtime buybot with per-group token configuration, buy alerts, liquidity alerts, milestones, reporting and custom presentation. Sell alerts are intentionally not included.

## Local setup

1. Copy `.env.example` to `.env` and fill the required values.
2. Run `npm ci`.
3. Run `npm test`.
4. Run `npm run start:all` only when the cloud worker is stopped; Telegram allows only one poller per bot token.

## Persistent data

Set `DATA_DIR=/data` on Render and attach a persistent disk there. `platform-state.enc` contains encrypted sessions, orders, tickets and user preferences. Wallet files created by new sessions use the encrypted `.wallets.enc` format. Legacy `.txt` wallet files remain readable for consolidation and are archived after successful processing.

State encryption uses `DATA_ENCRYPTION_KEY`. If it is absent, the controller `PRIVATE_KEY` is used as the derivation secret for backwards-compatible deployment. Changing both secrets without retaining the old value makes existing encrypted state unreadable.

## Volume/order commands

- `/start`, `/bump` — create an order.
- `/myorders`, `/status`, `/active` — session controls and statistics.
- `/dashboard`, `/history`, `/receipt ORDER_ID` — account and payment records.
- `/health`, `/demo [CA]` — read-only diagnostics and quote simulation.
- `/referral`, `/promo CODE` — referral and promotion flow.
- `/language en|fil`, `/timezone Asia/Manila` — preferences.
- `/support MESSAGE` — open a support ticket.

Admin-only commands are authorized by the configured Telegram ID: `/status_admin`, `/analyticsadmin`, `/ticketsadmin`, `/closeticket ID`, `/backupadmin`, `/stopalladmin`, `/refundalladmin`, and `/consolidateadmin`.

## Buybot setup

1. Add the buybot to a Telegram group.
2. A group administrator sends `/setup`; this also enables alerts.
3. Choose **Token, Filters & Milestones** to set a token CA. The bot discovers the highest-liquidity WETH pair, verifies the pool on-chain, reads its V3 fee and starts a watcher.
4. Configure the minimum buy, anti-spam batch window, market-cap milestones, liquidity alerts, timezone and custom template.
5. Use `/testalert`, `/health`, `/lastbuy`, `/stats` and `/config` to verify the setup.

Alert presentation supports images, GIFs, videos, standard emoji, Telegram custom emoji, project links and placeholders: `{token}`, `{symbol}`, `{weth}`, `{usd}`, `{buyer}`, and `{mc}`.

## Payment safety

Invoices record the creation block. Verification scans confirmed native transfers to the controller wallet and permanently claims a specific transaction hash. A transaction cannot credit two orders. Paid-order setup failures stay recorded for administrator recovery.

## Trading safety

Before an invoice is created, the volume bot checks contract bytecode, discovers and verifies a Uniswap V3 WETH or V4 native-ETH pool, enforces the configured liquidity minimum, and runs a two-way quote. V3 swaps use SwapRouter02; V4 swaps use Robinhood Chain's official PoolManager, V4Quoter, Universal Router and Permit2 deployments. Each swap uses a quote-derived minimum output and can enforce gas-price and daily-buy limits. `/stopalladmin` is the emergency stop.

These checks reduce operational risk but cannot prove a token is safe or guarantee execution price. Keep limits conservative and test with `/demo` first.

## Render

`render.yaml` defines the background worker and `/data` disk. Push a tested commit, deploy the latest commit in Render, and confirm logs contain both `Multi-user Trading Bot started` and `Realtime buybot running`.
