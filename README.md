# MintFlash

Telegram bot that mints NFTs on **Ethereum** and **Robinhood Chain**. Each user uploads an encrypted keystore. Private keys stay in RAM after `/unlock` and never go in chat as raw hex.

## Setup

```bash
npm install
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, RPCs, OPENSEA_API_KEY, DATA_DIR
npm test
npm start
```

Put `public/ethers.umd.min.js` next to the keystore page (see comment in the HTML). Point `PUBLIC_URL` at this host.

Use a VPS close to the chain you care about (Robinhood sequencer is us-east-2). Do not run live keys on Replit.

## Commands

| Command | What it does |
|---|---|
| `/wallets` | List. `/wallets add` upload. `/wallets remove 0x` |
| `/unlock` | Next message is the password (deleted when possible) |
| `/mint <link\|0x> [qty] [gas]` | Resolve, show live eligibility, fire |
| `/schedule <link> [gtd]` | Arm a hot poll at that stage start |
| `/schedule YYYY-MM-DD HH:MM <link\|0x>` | Exact time (offset from `SCHEDULE_TZ_OFFSET`) |
| `/jobs` `/cancel` `/wallet` `/lock` `/setprice` | Status, cancel, balances, lock, raw-contract price |

Gas presets: `slow` `normal` `fast` `instant` `aggressive`. Default is `fast`. On Robinhood, presets barely change tip — arrival time matters, not a gas war. There is no custom exact-gwei input — pick one of the five presets.

## Multiple wallets

If you have more than one wallet unlocked at once, every `/mint` or `/schedule` asks which wallet(s) to use before proceeding — a specific one, or explicitly "all". It never silently fires from every unlocked wallet by default. Eligibility checks (shown before a live `/mint`) cover every wallet you selected, not just the first one.

## How a scheduled mint fires

From 30s before `start_time` the bot polls OpenSea `POST /drops/{slug}/mint`. First `200` is the trigger. That calldata is simulated (`eth_call`), then signed locally and sent. Allowlist/GTD jobs do **not** fall back to `mintPublic`. The wallet(s) polled/fired for a given job are whichever you selected when you scheduled it.

You must be `/unlock`ed when it fires. The bot warns if auto-lock happens first.

## Safety

- One or more V3 keystores per Telegram user (`DATA_DIR/keystores/...`, mode 600)
- Price ceiling `MAX_PRICE_PER_TOKEN_ETH` (default 0.5)
- Balance check before send
- Unlock lockout after 5 bad passwords
- `/health` does not expose unlocked session count
- Empty `ALLOWED_USER_IDS` refuses to start unless `ALLOW_PUBLIC=true`
- At startup, each configured RPC is checked against its expected chain ID — a genuinely misconfigured RPC (pointing at the wrong network) stops the bot before it accepts any commands, instead of silently running

Only keep mint money in these wallets.
