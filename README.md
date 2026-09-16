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

Two different mechanisms, chosen automatically based on the stage:

**Confirmed public stage** (OpenSea reports it as `public_sale`, or the stage name contains "public"): no third party involved. The bot discovers the real on-chain start time at a relaxed polling cadence while there's time to spare, switches to tight monitoring only in the final ~2 seconds before it, then at that exact moment does a fresh final check (price, balance, gas, nonce) and signs and broadcasts immediately — signing only ever happens right at that moment, not ahead of time. If the transaction doesn't confirm within 8 seconds, it's automatically resubmitted with a bumped fee (same nonce, standard replace-by-fee) up to 3 times before falling back to one longer wait for whichever attempt lands.

**Allowlist (GTD/FCFS) or unrecognized stage type:** OpenSea's API is the only place the Merkle proof exists before the stage opens, so this path polls `POST /drops/{slug}/mint` every `POLL_INTERVAL_MS` starting `HOT_WINDOW_MS` before the target time, same as before — but gas is now prefetched on a slower parallel timer instead of only being fetched *after* a poll finally succeeds, removing that round-trip from the critical moment.

**A raw contract address with no OpenSea link** tries generic `mint()`/`publicMint()`/`claim()` guessing first, then falls back to direct SeaDrop `mintPublic` — this order matches the more common real-world case (a "mint from website" contract, not SeaDrop-based), and is safe because every send is simulated (`eth_call`) before ever broadcasting, so a wrong guess costs a cheap read, never a real transaction.

That calldata is simulated (`eth_call`) as part of building it, then signed locally and sent. Allowlist/GTD jobs do **not** fall back to `mintPublic`.

You must be `/unlock`ed when it fires. The bot warns if auto-lock happens first.

## Auto-lock

Set `AUTO_LOCK_MINUTES=0` to disable auto-lock entirely — a wallet stays decrypted in memory until you run `/lock` yourself or the process restarts. Only recommended for genuinely single-user setups; re-enable (any positive number) before adding other testers, since it directly controls how long a decrypted key sits in memory if the server were ever compromised.

## Safety

- One or more V3 keystores per Telegram user (`DATA_DIR/keystores/...`, mode 600)
- Price ceiling `MAX_PRICE_PER_TOKEN_ETH` (default 0.5)
- Balance check before send
- Unlock lockout after 5 bad passwords
- `/health` does not expose unlocked session count
- Empty `ALLOWED_USER_IDS` refuses to start unless `ALLOW_PUBLIC=true`
- At startup, each configured RPC is checked against its expected chain ID — a genuinely misconfigured RPC (pointing at the wrong network) stops the bot before it accepts any commands, instead of silently running

Only keep mint money in these wallets.
