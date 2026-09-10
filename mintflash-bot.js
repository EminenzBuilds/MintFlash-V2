/**
 * MintFlash v2 — Telegram mint bot (Ethereum + Robinhood Chain)
 *
 * Hot path: schedule ticker enters a builder poll T-30s, simulates, signs locally.
 * Keys: encrypted V3 keystores on disk, decrypted only in RAM.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { ethers } = require('ethers');
const { config, assertStartupConfig } = require('./lib/config');
const wallets = require('./lib/wallets');
const schedules = require('./lib/schedules');
const opensea = require('./lib/opensea');
const mint = require('./lib/mint');
const { checkRpcHealth, assertChainId } = require('./lib/rpc');
const { startTicker } = require('./lib/ticker');

assertStartupConfig();
wallets.ensureDirs();

const bot = new Telegraf(config.botToken);
const userState = new Map();
const unlockAttempts = new Map();
const MAX_UNLOCK_ATTEMPTS = 5;
const UNLOCK_LOCKOUT_MIN = 15;

function getState(userId) {
  const key = String(userId);
  if (!userState.has(key)) {
    userState.set(key, {
      flow: null,
      draft: emptyDraft(),
      waitingFor: null,
      pendingChoices: null,
      telegramUsername: null,
      manualPriceEth: null
    });
  }
  return userState.get(key);
}

function emptyDraft() {
  return {
    chain: 'eth',
    contract: null,
    openseaSlug: null,
    quantity: 1,
    gasPreset: 'fast',
    customMaxFee: null,
    customPriority: null,
    stageName: null,
    stageType: null,
    targetTimeISO: null,
    selectedAddresses: null, // null = ask if ambiguous; array = explicit choice from the wallet picker
    confirmationMessageId: null
  };
}

function resetFlow(state) {
  state.flow = null;
  state.draft = emptyDraft();
  state.waitingFor = null;
  state.pendingChoices = null;
}

function send(chatId, text, extra = {}) {
  return bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
}

function maskAddress(address) {
  if (!address || address.length < 10) return address || 'unknown';
  return `${address.slice(0, 6)}****${address.slice(-4)}`;
}

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const userId = String(ctx.from.id);
  if (!config.allowPublic && !config.allowedUsers.includes(userId)) {
    return ctx.reply(
      `⛔ Not authorized.\nYour Telegram ID: \`${userId}\``,
      { parse_mode: 'Markdown' }
    );
  }
  getState(userId).telegramUsername = ctx.from.username
    ? `@${ctx.from.username}`
    : (ctx.from.first_name || 'unknown');
  return next();
});

bot.start((ctx) => ctx.replyWithMarkdown('⚡ *MintFlash* is online.\nUse /help'));

bot.command('help', async (ctx) => {
  const keystore = config.keystorePageUrl
    ? `Keystore page: ${config.keystorePageUrl}`
    : 'Ask the owner for the keystore page URL.';
  await ctx.replyWithMarkdown(
`*MintFlash*

${keystore}

/wallets — list / add / remove
/unlock — then send password as next message
/lock

/mint <link|0x> [qty] [gas]
/schedule <link> [stage]
/schedule YYYY-MM-DD HH:MM <link|0x>
/jobs
/cancel
/wallet
/setprice <eth|clear>
/status`
  );
});

bot.command('wallets', async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1);
  const userId = String(ctx.from.id);

  if (args[0] === 'remove' && args[1]) {
    const ok = wallets.removeKeystore(userId, args[1]);
    return ctx.reply(ok ? '✅ Wallet removed.' : '❌ Wallet not found.');
  }

  if (args[0] === 'add') {
    getState(userId).waitingFor = 'keystoreUpload';
    return ctx.reply('Upload a `keystore.json` file now.', { parse_mode: 'Markdown' });
  }

  const stored = wallets.listStored(userId);
  const unlocked = new Set(wallets.listUnlocked(userId).map((a) => a.toLowerCase()));
  if (!stored.length) {
    getState(userId).waitingFor = 'keystoreUpload';
    return ctx.reply('No wallets yet. Upload a `keystore.json` now (or /wallets add).', { parse_mode: 'Markdown' });
  }
  const lines = stored.map((w) => {
    const flag = unlocked.has(w.address.toLowerCase()) ? 'unlocked' : 'locked';
    return `• \`${w.address}\` (${flag})`;
  });
  await ctx.replyWithMarkdown(`*Wallets*\n${lines.join('\n')}\n\nAdd: /wallets add\nRemove: /wallets remove 0x...`);
});

bot.on('document', async (ctx) => {
  const state = getState(ctx.from.id);
  if (state.waitingFor !== 'keystoreUpload') return;
  state.waitingFor = null;
  const doc = ctx.message.document;
  if (doc.file_size && doc.file_size > 20_000) {
    return ctx.reply('❌ File too large for a keystore.');
  }
  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(fileLink.href || fileLink);
    const text = await res.text();
    const address = wallets.saveKeystore(ctx.from.id, text);
    await ctx.reply(`✅ Saved \`${address}\`. /unlock to use it.`, { parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply(`❌ ${mint.errReason(e)}`);
  }
});

bot.command('unlock', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!wallets.hasStored(userId)) return ctx.reply('❌ No keystore — /wallets add first.');
  const limit = checkUnlockLimit(userId);
  if (limit.blocked) return ctx.reply(`🔒 Try again in ${limit.minutesLeft} min.`);
  getState(userId).waitingFor = 'unlockPassword';
  await ctx.reply('Send your keystore password as the next message. It will be deleted if possible.');
});

function checkUnlockLimit(userId) {
  const entry = unlockAttempts.get(userId);
  if (!entry || entry.count < MAX_UNLOCK_ATTEMPTS) return { blocked: false };
  const elapsed = (Date.now() - entry.lockedAt) / 60000;
  if (elapsed < UNLOCK_LOCKOUT_MIN) {
    return { blocked: true, minutesLeft: Math.ceil(UNLOCK_LOCKOUT_MIN - elapsed) };
  }
  unlockAttempts.delete(userId);
  return { blocked: false };
}

bot.command('lock', async (ctx) => {
  const ok = wallets.lock(ctx.from.id);
  await ctx.reply(ok ? '🔒 Locked.' : 'Already locked.');
});

bot.command('wallet', async (ctx) => {
  try {
    const list = wallets.getUnlockedWallets(ctx.from.id);
    const lines = [];
    for (const w of list) {
      const eth = await wallets.connectWallet(w, 'eth').provider.getBalance(w.address);
      const rh = await wallets.connectWallet(w, 'robinhood').provider.getBalance(w.address);
      lines.push(
        `\`${w.address}\`\nETH: ${ethers.formatEther(eth)}\nRH: ${ethers.formatEther(rh)}`
      );
    }
    await ctx.replyWithMarkdown(lines.join('\n\n') || 'No unlocked wallets.');
  } catch (e) {
    await ctx.reply(e.walletLocked ? `🔒 ${e.message}` : `❌ ${mint.errReason(e)}`);
  }
});

bot.command('setprice', async (ctx) => {
  const arg = ctx.message.text.split(/\s+/)[1];
  const state = getState(ctx.from.id);
  if (!arg) return ctx.reply('Usage: `/setprice 0.015` or `/setprice clear`', { parse_mode: 'Markdown' });
  if (arg.toLowerCase() === 'clear') {
    state.manualPriceEth = null;
    return ctx.reply('✅ Manual price cleared.');
  }
  const value = parseFloat(arg);
  if (Number.isNaN(value) || value < 0) return ctx.reply('❌ Invalid price.');
  state.manualPriceEth = value;
  await ctx.reply(`✅ Manual price ${value} ETH / token (raw contracts only).`);
});

bot.command('status', async (ctx) => statusReply(ctx));
bot.command('jobs', async (ctx) => statusReply(ctx));

async function statusReply(ctx) {
  const state = getState(ctx.from.id);
  const jobs = schedules.list(ctx.from.id);
  const jobLines = jobs.length
    ? jobs.map((s) => `• ${s.label} — \`${s.targetTimeISO}\``).join('\n')
    : 'None';
  const unlocked = wallets.listUnlocked(ctx.from.id);
  await ctx.replyWithMarkdown(
`*Status*
Unlocked: ${unlocked.length ? unlocked.map((a) => `\`${maskAddress(a)}\``).join(', ') : 'none'}
Draft slug: ${state.draft.openseaSlug || '—'}
Manual price: ${state.manualPriceEth ?? 'auto'}

*Jobs*
${jobLines}`
  );
}

bot.command('cancel', async (ctx) => {
  const entries = schedules.list(ctx.from.id);
  if (!entries.length) return ctx.reply('No scheduled jobs.');
  getState(ctx.from.id).pendingChoices = entries;
  const rows = entries.map((s, i) => [Markup.button.callback(s.label.slice(0, 40), `cancel_${i}`)]);
  await ctx.reply('Cancel which job?', Markup.inlineKeyboard(rows));
});

bot.action(/cancel_(\d+)/, async (ctx) => {
  const state = getState(ctx.from.id);
  const entry = state.pendingChoices?.[Number(ctx.match[1])];
  await ctx.answerCbQuery();
  if (!entry) return ctx.editMessageText('Selection expired.');
  schedules.remove(ctx.from.id, entry.id);
  state.pendingChoices = null;
  await ctx.editMessageText(`Cancelled: ${entry.label}`);
});

bot.command('mint', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  if (!parts.length) {
    return ctx.reply('Usage: `/mint <opensea-link|0x>` optional `[qty] [gas]`', { parse_mode: 'Markdown' });
  }
  const state = getState(ctx.from.id);
  resetFlow(state);
  state.flow = 'mint';
  state.draft.manualPriceEth = state.manualPriceEth;
  applyQtyGasArgs(state, parts.slice(1));
  return resolveTarget(ctx, parts[0], 'mint');
});

bot.command('schedule', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  const usage = 'Usage:\n`/schedule <link> [stage]`\n`/schedule YYYY-MM-DD HH:MM <link|0x>`';
  if (!parts.length) return ctx.reply(usage, { parse_mode: 'Markdown' });

  const state = getState(ctx.from.id);
  resetFlow(state);
  state.draft.manualPriceEth = state.manualPriceEth;

  if (parts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
    const target = new Date(`${parts[0]}T${parts[1]}:00${config.scheduleTzOffset}`);
    if (Number.isNaN(target.getTime())) return ctx.reply('❌ Invalid date/time.');
    if (target <= new Date()) return ctx.reply('❌ Time must be in the future.');
    state.flow = 'scheduleExact';
    state.draft.targetTimeISO = target.toISOString();
    return resolveTarget(ctx, parts[2], 'scheduleExact');
  }

  if (/^https?:\/\//i.test(parts[0])) {
    state.flow = 'scheduleStage';
    state.draft.stageQuery = parts.slice(1).join(' ') || null;
    return resolveTarget(ctx, parts[0], 'scheduleStage');
  }
  return ctx.reply(usage, { parse_mode: 'Markdown' });
});

function applyQtyGasArgs(state, args) {
  const presets = new Set(['slow', 'normal', 'fast', 'instant', 'aggressive']);
  for (const arg of args) {
    if (/^\d+$/.test(arg)) state.draft.quantity = parseInt(arg, 10);
    else if (presets.has(arg.toLowerCase())) state.draft.gasPreset = arg.toLowerCase();
  }
}

async function resolveTarget(ctx, raw, intent) {
  const state = getState(ctx.from.id);
  if (/^https?:\/\//i.test(raw)) {
    const slug = opensea.extractSlugFromUrl(raw);
    if (!slug) return ctx.reply('❌ Need an `opensea.io/collection/<slug>` link.');
    await ctx.reply(`⏳ Looking up \`${slug}\`...`, { parse_mode: 'Markdown' });
    let matches;
    try {
      matches = await opensea.fetchCollectionContracts(slug);
    } catch (e) {
      return ctx.reply(`❌ ${mint.errReason(e)}`);
    }
    if (!matches.length) return ctx.reply('❌ No contract on Ethereum or Robinhood Chain.');
    state.draft.openseaSlug = slug;
    if (matches.length === 1) {
      state.draft.contract = ethers.getAddress(matches[0].address);
      state.draft.chain = matches[0].chainKey;
      await ctx.reply(`✅ \`${state.draft.contract}\` on *${config.chains[state.draft.chain].name}*`, { parse_mode: 'Markdown' });
      return afterResolve(ctx, intent);
    }
    state.pendingChoices = matches;
    const buttons = matches.map((m, i) => Markup.button.callback(config.chains[m.chainKey].name, `chainpick_${i}`));
    return ctx.reply('Multiple chains — pick one:', Markup.inlineKeyboard([buttons]));
  }

  if (ethers.isAddress(raw)) {
    state.draft.contract = ethers.getAddress(raw);
    state.draft.openseaSlug = null;
    state.pendingChoices = { intent };
    return ctx.reply('Which chain?', Markup.inlineKeyboard([[
      Markup.button.callback('Ethereum', 'rawchain_eth'),
      Markup.button.callback('Robinhood', 'rawchain_robinhood')
    ]]));
  }
  return ctx.reply('❌ Not a link or address.');
}

bot.action(/chainpick_(\d+)/, async (ctx) => {
  const state = getState(ctx.from.id);
  const match = state.pendingChoices?.[Number(ctx.match[1])];
  await ctx.answerCbQuery();
  if (!match) return ctx.editMessageText('Expired — run the command again.');
  state.draft.contract = ethers.getAddress(match.address);
  state.draft.chain = match.chainKey;
  state.pendingChoices = null;
  await ctx.editMessageText(`✅ ${config.chains[match.chainKey].name}`);
  return afterResolve(ctx, state.flow);
});

bot.action(/rawchain_(.+)/, async (ctx) => {
  const state = getState(ctx.from.id);
  state.draft.chain = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText(`✅ ${config.chains[state.draft.chain].name}`);
  return afterResolve(ctx, state.flow);
});

async function afterResolve(ctx, intent) {
  const state = getState(ctx.from.id);
  const unlockedAddrs = wallets.listUnlocked(ctx.from.id);

  // More than one unlocked wallet and no explicit choice made yet for this
  // draft — ask, rather than silently firing from ALL of them. A user
  // might have multiple wallets unlocked for unrelated reasons (checking
  // balances, an earlier mint) without intending every one of them to
  // spend money on this particular mint.
  if (unlockedAddrs.length > 1 && !state.draft.selectedAddresses) {
    state.pendingChoices = { type: 'wallet', intent, addresses: unlockedAddrs };
    const buttons = unlockedAddrs.map((a, i) => Markup.button.callback(maskAddress(a), `walletpick_${i}`));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([Markup.button.callback(`All ${unlockedAddrs.length} wallets`, 'walletpick_all')]);
    return ctx.reply('You have multiple unlocked wallets. Mint from which?', Markup.inlineKeyboard(rows));
  }

  return continueAfterWalletPick(ctx, intent);
}

function continueAfterWalletPick(ctx, intent) {
  if (intent === 'scheduleStage') return startStageSchedule(ctx);
  if (intent === 'scheduleExact') return askQtyIfNeeded(ctx);
  return startMintFlow(ctx);
}

bot.action(/walletpick_(all|\d+)/, async (ctx) => {
  const state = getState(ctx.from.id);
  const pending = state.pendingChoices;
  await ctx.answerCbQuery();

  if (!pending || pending.type !== 'wallet') {
    return ctx.editMessageText('Selection expired — run the command again.');
  }

  const choice = ctx.match[1];
  if (choice === 'all') {
    // Explicit opt-in to "all" — different from the old default, which
    // fired from everything with no confirmation at all.
    state.draft.selectedAddresses = [...pending.addresses];
    await ctx.editMessageText(`✅ Using all ${pending.addresses.length} wallets`);
  } else {
    const addr = pending.addresses[Number(choice)];
    if (!addr) return ctx.editMessageText('Selection expired — run the command again.');
    state.draft.selectedAddresses = [addr];
    await ctx.editMessageText(`✅ Using ${maskAddress(addr)}`);
  }

  const intent = pending.intent;
  state.pendingChoices = null;
  return continueAfterWalletPick(ctx, intent);
});

async function startMintFlow(ctx) {
  const state = getState(ctx.from.id);
  let status = '';
  if (state.draft.openseaSlug) {
    const addrs = state.draft.selectedAddresses || wallets.listUnlocked(ctx.from.id);
    if (!addrs.length) {
      status = '🔒 Unlock to check eligibility.\n';
    } else {
      try {
        const checks = await Promise.all(addrs.map((a) => mint.checkEligibility(state.draft.openseaSlug, a)));
        status = checks.map((c, i) => `${c.ok ? '✅' : '⏳'} ${maskAddress(addrs[i])}: ${c.detail}`).join('\n') + '\n';
      } catch (e) {
        status = `❓ ${mint.errReason(e)}\n`;
      }
    }
  }
  if (ctx.message?.text?.split(/\s+/).length > 2 && state.draft.quantity) {
    await ctx.reply(`${status}🚀 Firing qty ${state.draft.quantity} / ${state.draft.gasPreset}...`);
    return fireDraft(ctx);
  }
  state.waitingFor = 'quantity';
  await ctx.reply(`${status}Send quantity, then pick gas. Or tap Mint now for qty 1 / fast.`, {
    ...Markup.inlineKeyboard([[
      Markup.button.callback('Mint now', 'fire_now'),
      Markup.button.callback('Schedule instead', 'goto_sched')
    ]])
  });
}

bot.action('fire_now', async (ctx) => {
  await ctx.answerCbQuery();
  getState(ctx.from.id).draft.quantity = getState(ctx.from.id).draft.quantity || 1;
  getState(ctx.from.id).draft.gasPreset = getState(ctx.from.id).draft.gasPreset || 'fast';
  await ctx.editMessageText('🚀 Firing...');
  return fireDraft(ctx);
});

bot.action('goto_sched', async (ctx) => {
  await ctx.answerCbQuery();
  getState(ctx.from.id).flow = 'scheduleStage';
  await ctx.editMessageText('Switching to schedule...');
  return startStageSchedule(ctx);
});

async function startStageSchedule(ctx) {
  const state = getState(ctx.from.id);
  if (!state.draft.openseaSlug) {
    return ctx.reply('Stage schedule needs an OpenSea link. Use `/schedule YYYY-MM-DD HH:MM 0x...` for raw contracts.', { parse_mode: 'Markdown' });
  }
  let dropInfo;
  try {
    dropInfo = await opensea.getDropInfo(state.draft.openseaSlug);
  } catch (e) {
    return ctx.reply(`❌ Could not load stages (${mint.errReason(e)}). Use exact-time /schedule.`);
  }

  if (state.draft.stageQuery) {
    const hit = opensea.findStageByLabel(dropInfo, state.draft.stageQuery);
    if (!hit) return ctx.reply(`❌ No stage matching "${state.draft.stageQuery}".`);
    applyStage(state, hit);
    return askQtyIfNeeded(ctx);
  }

  const upcoming = opensea.findUpcomingStages(dropInfo);
  const liveish = (dropInfo.stages || []).length && !upcoming.length;
  if (!upcoming.length) {
    return ctx.reply(liveish
      ? 'No upcoming stage start. If it is live, use /mint.'
      : 'No parseable upcoming stages. Use exact-time /schedule.');
  }
  if (upcoming.length === 1) {
    applyStage(state, upcoming[0]);
    return askQtyIfNeeded(ctx);
  }
  state.pendingChoices = upcoming;
  const lines = upcoming.map((s) => `${s.name} (${s.stageType || 'stage'}) — ${new Date(s.startMs).toISOString()}`).join('\n');
  const buttons = upcoming.map((s, i) => Markup.button.callback(s.name.slice(0, 30), `stage_${i}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  await ctx.reply(`Upcoming:\n${lines}`, Markup.inlineKeyboard(rows));
}

function applyStage(state, stage) {
  state.draft.stageName = stage.name;
  state.draft.stageType = stage.stageType;
  state.draft.targetTimeISO = new Date(stage.startMs).toISOString();
}

bot.action(/stage_(\d+)/, async (ctx) => {
  const state = getState(ctx.from.id);
  const stage = state.pendingChoices?.[Number(ctx.match[1])];
  await ctx.answerCbQuery();
  if (!stage) return ctx.editMessageText('Expired.');
  applyStage(state, stage);
  state.pendingChoices = null;
  await ctx.editMessageText(`✅ ${stage.name}`);
  return askQtyIfNeeded(ctx);
});

function askQtyIfNeeded(ctx) {
  const state = getState(ctx.from.id);
  state.waitingFor = 'quantity';
  const when = state.draft.targetTimeISO ? ` at \`${state.draft.targetTimeISO}\`` : '';
  return ctx.reply(`Send quantity, then gas. Scheduling${when}.`, { parse_mode: 'Markdown' });
}

bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();
  const state = getState(ctx.from.id);
  const userId = String(ctx.from.id);

  if (state.waitingFor === 'unlockPassword') {
    state.waitingFor = null;
    ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    const limit = checkUnlockLimit(userId);
    if (limit.blocked) return ctx.reply(`🔒 Try again in ${limit.minutesLeft} min.`);
    try {
      const result = await wallets.unlockAll(userId, text, ctx.chat.id, (chatId) => {
        send(chatId, `🔒 Auto-locked after ${config.autoLockMinutes} min.`).catch(() => {});
      });
      unlockAttempts.delete(userId);
      const extra = result.failed.length ? `\nCould not unlock ${result.failed.length} file(s).` : '';
      return ctx.reply(`✅ Unlocked ${result.addresses.length} wallet(s).${extra}\nAuto-lock ${config.autoLockMinutes} min.`);
    } catch (e) {
      const entry = unlockAttempts.get(userId) || { count: 0, lockedAt: null };
      entry.count += 1;
      if (entry.count >= MAX_UNLOCK_ATTEMPTS) entry.lockedAt = Date.now();
      unlockAttempts.set(userId, entry);
      return ctx.reply(`❌ ${mint.errReason(e)}`);
    }
  }

  if (state.waitingFor === 'quantity') {
    const qty = parseInt(text, 10);
    if (Number.isNaN(qty) || qty < 1) return ctx.reply('Send a number ≥ 1.');
    state.draft.quantity = qty;
    state.waitingFor = null;
    return ctx.reply('Gas preset:', Markup.inlineKeyboard([
      [
        Markup.button.callback('Slow', 'gas_slow'),
        Markup.button.callback('Normal', 'gas_normal'),
        Markup.button.callback('Fast', 'gas_fast')
      ],
      [
        Markup.button.callback('Instant', 'gas_instant'),
        Markup.button.callback('Aggressive', 'gas_aggressive')
      ]
    ]));
  }
});

bot.action(/gas_(.+)/, async (ctx) => {
  const state = getState(ctx.from.id);
  state.draft.gasPreset = ctx.match[1];
  await ctx.answerCbQuery();
  if (state.flow === 'mint') {
    await ctx.editMessageText('🚀 Firing...');
    return fireDraft(ctx);
  }
  await ctx.editMessageText(`Gas: ${state.draft.gasPreset}`);
  return armFromDraft(ctx);
});

function intentFromDraft(userId, chatId, draft, extra = {}) {
  return {
    userId: String(userId),
    chatId,
    contract: draft.contract,
    chain: draft.chain,
    quantity: draft.quantity || 1,
    gasPreset: draft.gasPreset || 'fast',
    customMaxFee: draft.customMaxFee,
    customPriority: draft.customPriority,
    manualPriceEth: draft.manualPriceEth ?? getState(userId).manualPriceEth,
    openseaSlug: draft.openseaSlug,
    stageName: draft.stageName,
    stageType: draft.stageType,
    addresses: draft.selectedAddresses || null,
    confirmationMessageId: draft.confirmationMessageId || extra.confirmationMessageId || null,
    prebuiltByWallet: extra.prebuiltByWallet || null
  };
}

function warnUnlockWindow(ctx, userId, targetDate) {
  const minutesUntilTarget = (targetDate.getTime() - Date.now()) / 60000;
  const minutesUntilLock = wallets.minutesUntilAutoLock(userId);
  if (minutesUntilLock == null) {
    ctx.reply(`⚠️ Wallet locked. /unlock within ${config.autoLockMinutes} min of fire time.`).catch(() => {});
    return;
  }
  if (minutesUntilTarget > minutesUntilLock) {
    ctx.reply(`⚠️ Auto-lock in ${Math.round(minutesUntilLock)} min; job fires in ${Math.round(minutesUntilTarget)} min. /unlock again closer to time.`).catch(() => {});
  }
}

async function armFromDraft(ctx) {
  const state = getState(ctx.from.id);
  const target = new Date(state.draft.targetTimeISO);
  if (Number.isNaN(target.getTime())) return ctx.reply('❌ Missing schedule time.');
  if (target <= new Date()) {
    await ctx.reply('Stage already started — firing now.');
    return fireDraft(ctx);
  }
  const userId = String(ctx.from.id);
  const label = `${state.draft.stageName || state.draft.openseaSlug || state.draft.contract.slice(0, 10)} (${state.draft.gasPreset})`;
  const entry = {
    id: schedules.generateId(),
    chatId: ctx.chat.id,
    contract: state.draft.contract,
    chain: state.draft.chain,
    quantity: state.draft.quantity,
    gasPreset: state.draft.gasPreset,
    customMaxFee: state.draft.customMaxFee,
    customPriority: state.draft.customPriority,
    manualPriceEth: state.manualPriceEth,
    openseaSlug: state.draft.openseaSlug,
    stageName: state.draft.stageName,
    stageType: state.draft.stageType,
    addresses: state.draft.selectedAddresses || null,
    targetTimeISO: target.toISOString(),
    label
  };
  const sent = await ctx.reply(
    `✅ Scheduled *${label}*\n\`${entry.targetTimeISO}\`\nQty ${entry.quantity} · ${entry.gasPreset}`,
    { parse_mode: 'Markdown' }
  );
  entry.confirmationMessageId = sent.message_id;
  schedules.add(userId, entry);
  warnUnlockWindow(ctx, userId, target);
  resetFlow(state);
}

async function fireDraft(ctx) {
  const state = getState(ctx.from.id);
  const intent = intentFromDraft(ctx.from.id, ctx.chat.id, state.draft);
  await runMintAndReport(intent);
  resetFlow(state);
}

function replyExtra(intent) {
  return intent.confirmationMessageId
    ? { reply_parameters: { message_id: intent.confirmationMessageId, allow_sending_without_reply: true } }
    : {};
}

async function runMintAndReport(intent) {
  const chain = config.chains[intent.chain];
  try {
    const outcomes = await mint.performMint(intent);
    for (const { wallet, result, errors } of outcomes) {
      if (!result) {
        const line = mint.summarizeFailure(errors);
        await send(intent.chatId, `${maskAddress(wallet.address)}\n${line}`, replyExtra(intent));
        postDiscord({ success: false, intent, wallet, errorLine: line }).catch(() => {});
        continue;
      }
      await send(intent.chatId, `🚀 ${maskAddress(wallet.address)} sent via *${result.usedMethod}*\n\`${result.tx.hash}\``, replyExtra(intent));
      const receipt = await result.tx.wait();
      await send(
        intent.chatId,
        `✅ Confirmed block \`${receipt.blockNumber}\`\n[tx](${chain.explorer}${result.tx.hash})`,
        replyExtra(intent)
      );
      postDiscord({ success: true, intent, wallet, tx: result.tx }).catch(() => {});
    }
  } catch (e) {
    if (e.walletLocked) {
      await send(intent.chatId, '🔒 Wallet locked — /unlock then /mint again if the stage is still open.', replyExtra(intent));
    } else {
      await send(intent.chatId, `❌ ${mint.errReason(e).slice(0, 300)}`, replyExtra(intent));
    }
  }
}

async function onScheduledFire(userId, entry, extra) {
  schedules.remove(userId, entry.id);
  const intent = {
    userId,
    chatId: entry.chatId,
    contract: entry.contract,
    chain: entry.chain,
    quantity: entry.quantity,
    gasPreset: entry.gasPreset,
    customMaxFee: entry.customMaxFee,
    customPriority: entry.customPriority,
    manualPriceEth: entry.manualPriceEth,
    openseaSlug: entry.openseaSlug,
    stageName: entry.stageName,
    stageType: entry.stageType,
    addresses: entry.addresses || null,
    confirmationMessageId: entry.confirmationMessageId,
    prebuiltByWallet: extra.prebuiltByWallet || null
  };
  if (extra.locked) {
    await send(entry.chatId, `🔒 *${entry.label}* fired while locked. /unlock and /mint if still open.`, replyExtra(intent));
    return;
  }
  if (extra.error) {
    await send(entry.chatId, `❌ *${entry.label}* hot poll failed: ${mint.errReason(extra.error)}`, replyExtra(intent));
    return;
  }
  await runMintAndReport(intent);
}

async function postDiscord({ success, intent, wallet, tx, errorLine }) {
  if (!config.discordWebhookUrl) return;
  const title = success ? '✅ Mint Successful' : '❌ Mint Failed';
  const desc = [
    `**${intent.openseaSlug || intent.contract}** · ${config.chains[intent.chain].name}`,
    success ? `[tx](${config.chains[intent.chain].explorer}${tx.hash})` : errorLine,
    `${getState(intent.userId).telegramUsername} · \`${maskAddress(wallet.address)}\``
  ].join('\n');
  const embed = { title, color: success ? 0x2ecc71 : 0xe74c3c, description: desc, timestamp: new Date().toISOString() };
  if (intent.openseaSlug) {
    const image = await opensea.collectionImage(intent.openseaSlug);
    if (image) embed.thumbnail = { url: image };
  }
  await fetch(config.discordWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] })
  });
}

const app = express();
const startedAt = Date.now();
app.get('/', (_req, res) => res.send('MintFlash is running'));
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    scheduledMints: schedules.countAll()
  });
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/keystore', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'keystore-generator.html'));
});
app.listen(config.port, () => console.log(`HTTP on ${config.port}`));

setInterval(async () => {
  const results = await checkRpcHealth();
  for (const r of results) {
    if (r.ok) continue;
    const msg = `⚠️ RPC down: ${config.chains[r.chainKey].name} — ${r.error}`;
    console.error(msg);
    if (config.ownerChatId) send(config.ownerChatId, msg).catch(() => {});
  }
}, 10 * 60 * 1000);

// Confirms each configured RPC actually reports the chain ID it's supposed
// to — catches a misconfigured RPC URL silently pointing at the wrong
// network before any user can mint against it. A genuine mismatch is
// treated as fatal (better to refuse to start than let money move on the
// wrong chain); a connection failure here is just a warning, since that's
// covered separately by the ongoing RPC health check below.
async function verifyChainConfiguration() {
  for (const chainKey of Object.keys(config.chains)) {
    if (!config.chains[chainKey].rpcs.length) continue;
    try {
      await assertChainId(chainKey);
    } catch (e) {
      if (/returned chainId/.test(e.message)) {
        console.error(`❌ FATAL: ${e.message}`);
        process.exit(1);
      }
      console.warn(`⚠️ Could not verify chain ID for ${config.chains[chainKey].name} at startup: ${e.message}`);
    }
  }
}

startTicker(onScheduledFire);

verifyChainConfiguration()
  .then(() => bot.launch())
  .then(() => console.log('MintFlash v2 running'))
  .catch((err) => {
    console.error('Failed to start', err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
