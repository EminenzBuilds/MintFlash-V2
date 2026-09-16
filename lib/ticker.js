const { config } = require('./config');
const schedules = require('./schedules');
const { buildOpenSeaMintTx } = require('./opensea');
const { listUnlocked } = require('./wallets');
const mint = require('./mint');

const hotJobs = new Set();
const fired = new Set();

function keyOf(userId, id) {
  return `${userId}:${id}`;
}

function resolveAddresses(userId, entry) {
  let addresses = listUnlocked(userId);
  if (entry.addresses?.length) {
    const allow = new Set(entry.addresses.map((a) => a.toLowerCase()));
    addresses = addresses.filter((a) => allow.has(a.toLowerCase()));
  }
  return addresses;
}

// Deliberately narrower than mint.js's allowPublicFallback (which also
// returns true for "no slug at all" — appropriate for its own purpose of
// deciding a mid-mint fallback, but wrong here). Pre-signing only ever
// applies to a CONFIRMED public OpenSea-resolved stage — anything without
// a slug keeps its existing behavior untouched below, since that path
// already has the full SeaDrop-then-generic-guess fallback chain that the
// pre-sign path does not implement.
function isKnownPublicOpenSeaStage(entry) {
  if (!entry.openseaSlug) return false;
  const type = String(entry.stageType || '').toLowerCase();
  const name = String(entry.stageName || '').toLowerCase();
  return type === 'public_sale' || name.includes('public');
}

// --- Allowlist / unknown-stage OpenSea path: polling OpenSea's API is
// unavoidable here (the proof only exists on their servers) — but gas is
// now prefetched on a slower parallel cadence instead of only being
// fetched fresh after a poll finally succeeds, removing that RPC
// round-trip from the critical moment. ---
async function pollUntilReady(entry, addresses) {
  const deadline = new Date(entry.targetTimeISO).getTime() + 90_000;
  const prebuiltByWallet = {};
  let lastError = null;
  let cachedOverrides = null;
  let lastGasFetch = 0;
  const GAS_REFRESH_MS = 2000; // gas doesn't need 200ms-tight refreshing — only the OpenSea calldata check does

  while (Date.now() < deadline) {
    if (Date.now() - lastGasFetch >= GAS_REFRESH_MS) {
      lastGasFetch = Date.now();
      // Fire-and-forget on purpose — a failed refresh just means the mint
      // attempt falls back to fetching its own gas fresh, same as before
      // this change. Must never block or slow down the tight poll loop below.
      mint.buildOverrides({
        chain: entry.chain,
        gasPreset: entry.gasPreset,
        customMaxFee: entry.customMaxFee,
        customPriority: entry.customPriority,
        quantity: entry.quantity
      }).then((o) => { cachedOverrides = o; }).catch(() => {});
    }

    for (const address of addresses) {
      if (prebuiltByWallet[address.toLowerCase()]) continue;
      try {
        const built = await buildOpenSeaMintTx(entry.openseaSlug, address, entry.quantity);
        prebuiltByWallet[address.toLowerCase()] = built;
      } catch (e) {
        lastError = e;
        if (e.opensea422) continue;
      }
    }
    if (Object.keys(prebuiltByWallet).length) {
      return { prebuiltByWallet, lastError, prefetchedOverrides: cachedOverrides };
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
  return { prebuiltByWallet, lastError, prefetchedOverrides: cachedOverrides };
}

// --- Confirmed public-stage path: no third party to ask — discover the
// real on-chain start time (polled at a relaxed cadence, since it doesn't
// change often), tighten to close-interval monitoring only in the final
// approach, then fire at T0. Signing happens only at T0 itself (see
// mint.fireDirectPublicMint) — not ahead of time — since signing is fast
// enough that pre-signing bought negligible speed while risking a stale
// nonce/gas if conditions shifted before the actual broadcast.
//
// NOTE: architecturally sound but not exercised against a live chain in
// this environment — verify against a real, ideally low-stakes public mint
// before trusting this on something competitive.
const DISCOVERY_REFRESH_MS = 3000; // relaxed cadence while still far from start time
const AGGRESSIVE_WINDOW_MS = 2000; // switch to tight monitoring inside this final stretch
const AGGRESSIVE_POLL_MS = 150; // tight polling cadence once inside the final stretch

async function watchAndFirePublic(userId, entry, k, onFire) {
  const intent = {
    userId,
    contract: entry.contract,
    chain: entry.chain,
    quantity: entry.quantity,
    gasPreset: entry.gasPreset,
    customMaxFee: entry.customMaxFee,
    customPriority: entry.customPriority,
    addresses: entry.addresses || null
  };

  const deadline = new Date(entry.targetTimeISO).getTime() + 90_000;
  let wallets;

  try {
    wallets = mint.getWalletsForIntent(intent);
  } catch (e) {
    fired.add(k);
    await onFire(userId, entry, e.walletLocked ? { locked: true } : { error: e });
    return;
  }

  // Phase 1 — discovery, relaxed cadence: find the real on-chain start
  // time. This is a read-only check, safe to repeat, and doesn't need to be
  // tight since the start time itself rarely changes once set.
  let startTimeMs = null;
  while (Date.now() < deadline) {
    try {
      const infos = await Promise.all(wallets.map((w) => mint.readPublicDropInfo(intent, w)));
      const times = infos.map((i) => i.startTime).filter((t) => typeof t === 'number' && t > 0);
      if (times.length) startTimeMs = Math.min(...times) * 1000;
    } catch {
      // Transient read failure — retry next cycle rather than give up.
    }

    const target = startTimeMs || new Date(entry.targetTimeISO).getTime();
    if (target - Date.now() <= AGGRESSIVE_WINDOW_MS) break; // close enough — move to tight monitoring
    await new Promise((r) => setTimeout(r, DISCOVERY_REFRESH_MS));
  }

  // Phase 2 — aggressive final approach: tight polling only for the last
  // stretch, right up to the actual target moment.
  const finalTarget = startTimeMs || new Date(entry.targetTimeISO).getTime();
  while (Date.now() < finalTarget && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, AGGRESSIVE_POLL_MS));
  }

  fired.add(k);

  // T0 — fire for every wallet. Each call does its own final fresh
  // state/nonce/gas check, signs, broadcasts, and handles replacement if
  // the send doesn't confirm promptly.
  const results = {};
  await Promise.all(wallets.map(async (wallet) => {
    try {
      const { tx, receipt, replacements } = await mint.fireDirectPublicMint(intent, wallet);
      results[wallet.address.toLowerCase()] = { tx, receipt, replacements, wallet };
    } catch (e) {
      results[wallet.address.toLowerCase()] = { error: mint.errReason(e), wallet };
    }
  }));

  await onFire(userId, entry, { presigned: results });
}

function startTicker(onFire) {
  setInterval(async () => {
    const now = Date.now();
    for (const { userId, entry } of schedules.allEntries()) {
      const k = keyOf(userId, entry.id);
      if (fired.has(k)) continue;
      const start = new Date(entry.targetTimeISO).getTime();
      if (Number.isNaN(start)) continue;

      const inHot = now >= start - config.hotWindowMs;
      if (!inHot) continue;
      if (hotJobs.has(k)) continue;

      if (isKnownPublicOpenSeaStage(entry)) {
        hotJobs.add(k);
        watchAndFirePublic(userId, entry, k, onFire).finally(() => hotJobs.delete(k));
        continue;
      }

      if (entry.openseaSlug && config.openseaApiKey) {
        hotJobs.add(k);
        const addresses = resolveAddresses(userId, entry);
        if (!addresses.length) {
          if (now >= start) {
            fired.add(k);
            await onFire(userId, entry, { locked: true });
          } else {
            hotJobs.delete(k);
          }
          continue;
        }
        try {
          const { prebuiltByWallet, prefetchedOverrides } = await pollUntilReady(entry, addresses);
          fired.add(k);
          await onFire(userId, entry, { prebuiltByWallet, prefetchedOverrides });
        } catch (e) {
          fired.add(k);
          await onFire(userId, entry, { error: e });
        } finally {
          hotJobs.delete(k);
        }
        continue;
      }

      // No OpenSea slug at all — unchanged from before. Still goes through
      // the full performMint fallback chain (direct SeaDrop, then generic
      // mint() guessing), which the new pre-sign path does not implement.
      if (now >= start) {
        fired.add(k);
        await onFire(userId, entry, {});
      }
    }
  }, 1000);
}

module.exports = { startTicker };
