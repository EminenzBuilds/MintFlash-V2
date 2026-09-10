const { config } = require('./config');
const schedules = require('./schedules');
const { buildOpenSeaMintTx } = require('./opensea');
const { listUnlocked } = require('./wallets');

const hotJobs = new Set();
const fired = new Set();

function keyOf(userId, id) {
  return `${userId}:${id}`;
}

async function pollUntilReady(entry, addresses) {
  const deadline = new Date(entry.targetTimeISO).getTime() + 90_000;
  const prebuiltByWallet = {};
  let lastError = null;

  while (Date.now() < deadline) {
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
    if (Object.keys(prebuiltByWallet).length) return { prebuiltByWallet, lastError };
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
  return { prebuiltByWallet, lastError };
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

      if (entry.openseaSlug && config.openseaApiKey) {
        if (hotJobs.has(k)) continue;
        hotJobs.add(k);
        let addresses = listUnlocked(userId);
        if (entry.addresses?.length) {
          const allow = new Set(entry.addresses.map((a) => a.toLowerCase()));
          addresses = addresses.filter((a) => allow.has(a.toLowerCase()));
        }
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
          const { prebuiltByWallet } = await pollUntilReady(entry, addresses);
          fired.add(k);
          await onFire(userId, entry, { prebuiltByWallet });
        } catch (e) {
          fired.add(k);
          await onFire(userId, entry, { error: e });
        } finally {
          hotJobs.delete(k);
        }
        continue;
      }

      if (now >= start) {
        fired.add(k);
        await onFire(userId, entry, {});
      }
    }
  }, 1000);
}

module.exports = { startTicker };
