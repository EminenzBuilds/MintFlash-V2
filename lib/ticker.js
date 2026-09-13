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

// --- Confirmed public-stage path: no third party to ask — build and SIGN
// ahead of time (refreshed periodically so gas/nonce stay current), then
// broadcast the instant on-chain start time is reached. Collapses t-0 down
// to "send an already-finished object", which is as fast as this gets.
//
// NOTE: architecturally sound but not exercised against a live chain in
// this environment — verify against a real, ideally low-stakes public mint
// before trusting this on something competitive.
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

  const REFRESH_MS = 3000;
  const deadline = new Date(entry.targetTimeISO).getTime() + 90_000;
  let latest = null;

  while (Date.now() < deadline) {
    try {
      latest = await mint.prepareSignedPublicMints(intent);
    } catch (e) {
      if (e.walletLocked) {
        fired.add(k);
        await onFire(userId, entry, { locked: true });
        return;
      }
      // Transient read failure (RPC hiccup, etc.) — try again next cycle
      // rather than giving up on the whole job.
    }

    const startTimes = Object.values(latest || {})
      .map((r) => r.startTime)
      .filter((t) => typeof t === 'number' && t > 0);
    const startTimeMs = startTimes.length ? Math.min(...startTimes) * 1000 : null;

    // Prefer the real on-chain start time once we've read it; fall back to
    // the originally scheduled time if that read never succeeded, so a job
    // can't get stuck waiting forever on a read failure alone.
    if (startTimeMs && Date.now() >= startTimeMs) break;
    if (!startTimeMs && Date.now() >= new Date(entry.targetTimeISO).getTime()) break;

    await new Promise((r) => setTimeout(r, REFRESH_MS));
  }

  fired.add(k);

  if (!latest || !Object.keys(latest).length) {
    await onFire(userId, entry, { error: new Error('Could not prepare a signed transaction for any wallet') });
    return;
  }

  const results = {};
  for (const [addr, info] of Object.entries(latest)) {
    if (info.error) {
      results[addr] = { error: info.error };
      continue;
    }
    try {
      const tx = await mint.fireSignedPublicMint(info.wallet, info.signedTx);
      results[addr] = { tx, wallet: info.wallet };
    } catch (e) {
      results[addr] = { error: mint.errReason(e) };
    }
  }

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
