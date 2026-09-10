MINTFLASH — HOW TO USE THIS BOT
================================

MintFlash mints NFTs for you on Ethereum and Robinhood Chain, including
scheduling a mint to fire the instant a drop opens. Every user brings their
own wallet — nothing is shared between users, and your private key never
touches this bot directly.


0. GETTING ACCESS
------------------
This bot only responds to people the owner has explicitly allowed. If you
message it and get "You are not authorized", it will show you your own
Telegram ID — send that ID to whoever gave you the bot link so they can add
you.


1. SET UP YOUR WALLET (do this once)
-------------------------------------
Your private key is never typed into this chat. Instead:

  a. Open the keystore generator page (ask the bot owner for the link, or
     check /help). It runs entirely in your own browser — nothing is sent
     anywhere, including to the bot.

  b. Enter your private key and a password, click Generate. This downloads
     a file called keystore.json. Your key is now encrypted inside that
     file; without your password, that file is useless to anyone.

  c. Back in the bot, run:
       /setkeystore
     and upload the keystore.json file you just downloaded (as an actual
     file attachment, not pasted text).

  d. Whenever you want to mint, run:
       /unlock yourpassword
     This decrypts your wallet into memory for this session only. It is
     never written to disk unencrypted, and it locks itself again
     automatically after 90 minutes of being unlocked (or whatever the bot
     owner has configured) — you'll get a message when that happens. You
     can lock it early yourself with /lock.

     If you schedule a mint further out than your remaining unlock time,
     the bot will warn you immediately when you schedule it, not just when
     it fails later. If you see that warning, just run /unlock again
     closer to the actual mint time to reset the clock.

IMPORTANT: your password is not stored anywhere and cannot be recovered.
If you forget it, you'll need to generate a new keystore from your private
key again and re-upload it. Never share your private key or your keystore
password with anyone, including the bot owner.


2. MINT RIGHT NOW
------------------
  /mint <opensea-collection-link>

Example:
  /mint https://opensea.io/collection/cash-monkeysss

This looks up the collection on OpenSea, figures out the contract and
chain automatically, then asks you for:
  - Quantity (how many to mint)
  - Gas speed (Slow / Normal / Fast / Instant / Aggressive / Custom)

...and fires immediately once you've answered both. There's no
confirmation step and no eligibility pre-check — if the current stage
doesn't allow your wallet to mint (wrong allowlist, limit reached, etc.),
you'll get that as a clear error message right after trying, not before.

For a contract that isn't listed on OpenSea at all (a non-SeaDrop custom
mint, for example), pass the raw address instead of a link:
  /mint 0xYourContractAddress
Since there's no OpenSea listing to read the chain from, you'll be asked
to pick Ethereum or Robinhood Chain first, then it proceeds the same way
(quantity, gas, fire). If the contract needs a mint price the bot can't
auto-detect, set it first with /setprice.

Want to see whether you're currently eligible before committing to
anything? Use /oslink instead of /mint — same lookup, but it checks
eligibility for whatever stage is live right now before asking for
quantity. (It can only check the stage that's actually open at that
moment — it can't know in advance whether you're on a list for a stage
that hasn't started yet. See section 3 for that case.)


3. SCHEDULE A MINT FOR WHEN A STAGE OPENS
-------------------------------------------
  /schedule <opensea-collection-link>

This reads the drop's public schedule and figures out what stage(s) are
coming up. If there's more than one, it'll show you a list of stage names
and times and ask which one you want — pick the one you believe you're
eligible for. Then it asks quantity and gas, same as /mint, and arms the
mint to fire automatically the moment that stage opens.

You can also schedule for an exact date/time instead of a stage — a
link or contract address is required here too, so the bot always knows
exactly what it's scheduling rather than guessing from whatever you last
had set up:
  /schedule 2026-08-15 15:00 https://opensea.io/collection/your-collection
  /schedule 2026-08-15 15:00 0xYourContractAddress
(Time is interpreted as GMT+1.) This skips the stage picker and eligibility
check entirely — it fires at that exact moment regardless of what stage is
active then. The raw-address form asks which chain first, the same way
/mint does for a non-OpenSea contract.

You can have more than one mint scheduled at a time — for different drops,
or different stages of the same drop.

To cancel one:
  /cancel
This shows you a list of everything you currently have scheduled; tap the
one you want to cancel.

Note: if the bot restarts while your wallet is locked, a scheduled mint
that fires during that window won't be able to sign anything. You'll get a
message telling you this happened — just /unlock again and use /mintnow
if the stage might still be open.


4. OTHER USEFUL COMMANDS
--------------------------
  /wallet            Show your address and balances (must be unlocked)
  /status             Show your current settings and scheduled mints
  /chain               Switch between Ethereum and Robinhood Chain
  /setprice 0.015    Manually set a mint price if the bot can't auto-detect
                        one for a non-OpenSea contract (/setprice clear to
                        remove it)
  /mintnow             Fire a mint again using your last-used settings
  /help                Short command reference


5. GAS PRESETS — WHAT THEY ACTUALLY COST
-------------------------------------------
When you pick a gas speed, the bot fetches the network's CURRENT fee data
and scales it by a multiplier for your chosen speed — it does not use a
fixed number. This matters because a fixed gwei value can become stale:
during a genuinely busy moment (a popular drop, network congestion), a
static "Aggressive" might not be enough, and during a quiet moment it
might wildly overpay for nothing.

  Preset       Multiplier over current network base fee
  ----------   ------------------------------------------
  Slow         1.0x  (network's own suggested rate)
  Normal       1.25x
  Fast         1.6x
  Instant      2.5x
  Aggressive   5.0x

Like before, the amount you're quoted (via maxFeePerGas) is a CEILING —
Ethereum only actually charges the real current rate up to that cap, and
refunds anything you didn't need. Rough formula for a worst-case estimate:
worst-case ETH cost = maxFeePerGas x (150,000 x quantity + 150,000) x
0.000000001. Since maxFeePerGas now depends on live network conditions,
there's no fixed number to quote here — check /status right before minting
if you want a sense of current cost.

If the bot can't reach the network to fetch live fee data for any reason,
it falls back to a fixed conservative estimate rather than blocking the
mint entirely — this is a safety net, not the normal path.

Robinhood Chain and Ethereum are scaled independently, each off their own
live network conditions — use /chain to confirm which one you're on.


6. SAFETY LIMITS BUILT INTO THE BOT
--------------------------------------
A few automatic guardrails exist regardless of what you do:

  - Price sanity ceiling: every mint attempt checks the quoted price per
    token against a configured maximum (set by the bot owner) before
    signing anything. This exists so a bug or bad response from any price
    source can't result in the bot blindly signing an absurd amount.
  - Balance check: the bot confirms your wallet can actually cover the
    price plus worst-case gas before attempting to send, instead of
    letting it fail as a raw on-chain revert.
  - Unlock lockout: too many wrong /unlock password attempts in a row
    locks out further attempts for a cooldown period, protecting against
    someone trying to brute-force a stolen keystore file.

WHY OPENSEA LINKS ARE FASTER FOR COMPETITIVE MINTS: when you use an
OpenSea link (/mint, /oslink, /schedule with a link), the bot already
knows for certain this is a SeaDrop drop and goes straight to the correct
call. A raw contract address (/mint 0x..., /schedule ... 0x...) means the
bot doesn't know what kind of contract it is — it checks for SeaDrop first
(a cheap read, no wasted transaction if it's not), then only as a last
resort tries guessing generic mint functions, which DOES cost a real,
slower, on-chain transaction if the guess is wrong. For a genuinely
competitive free mint, prefer the OpenSea link form whenever the
collection is listed there.


7. DISCORD ACTIVITY LOG
--------------------------
If the bot owner has set this up, every mint attempt (successful or
failed) posts to a Discord channel automatically — collection, chain,
quantity, who minted it (Telegram username), and a partially-masked
wallet address (first few and last 4 characters only, never the full
address). This is visible to everyone in that Discord channel, so keep
that in mind — it's meant as shared community visibility, not a private
log.


8. A NOTE ON SAFETY
----------------------
  - Your private key should only ever be typed into the official keystore
    generator page — nowhere else, ever, including this chat.
  - The bot cannot recover a lost keystore password. Keep it somewhere
    safe.
  - Only keep in this wallet what you're actually planning to use for
    minting. Treat it like a hot wallet, not your main holdings.
