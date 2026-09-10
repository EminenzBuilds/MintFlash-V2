/**
 * Deterministic helpers — no network, no env, no side effects.
 */

function extractSlugFromUrl(url) {
  const match = String(url || '').match(/opensea\.io\/collection\/([a-zA-Z0-9-]+)/i);
  return match ? match[1] : null;
}

function parseStageStartMs(stage) {
  const raw = stage.start_time ?? stage.startTime ?? stage.start ?? null;
  if (raw == null) return null;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function stageLabel(stage) {
  return (
    stage.label ||
    stage.name ||
    stage.stageName ||
    stage.stage_name ||
    stage.title ||
    null
  );
}

function stageTypeOf(stage) {
  return stage.stage_type || stage.stageType || stage.type || null;
}

function normalizeDropStages(dropInfo) {
  const stages = dropInfo?.stages || dropInfo?.presale_stages || dropInfo?.phases || [];
  return stages.map((s) => {
    const startMs = parseStageStartMs(s);
    return {
      uuid: s.uuid || null,
      name: stageLabel(s),
      stageType: stageTypeOf(s),
      startMs,
      endMs: parseStageStartMs({ start_time: s.end_time ?? s.endTime }) || null,
      price: s.price ?? s.mintPrice ?? null,
      limit: s.max_per_wallet ?? s.maxPerWallet ?? s.max_total_mintable_by_wallet ?? s.limit ?? null,
      raw: s
    };
  }).filter((s) => s.startMs != null);
}

function findUpcomingStages(dropInfo, now = Date.now()) {
  const upcoming = normalizeDropStages(dropInfo)
    .filter((s) => s.startMs > now)
    .sort((a, b) => a.startMs - b.startMs);

  upcoming.forEach((s, i) => {
    if (!s.name) s.name = `Upcoming Phase ${i + 1}`;
  });
  return upcoming;
}

function findStageByLabel(dropInfo, query, now = Date.now()) {
  if (!query) return null;
  const q = String(query).trim().toLowerCase();
  const stages = normalizeDropStages(dropInfo).sort((a, b) => a.startMs - b.startMs);
  const match = stages.find((s) => (s.name || '').toLowerCase() === q)
    || stages.find((s) => (s.name || '').toLowerCase().includes(q));
  if (!match) return null;
  if (match.endMs && match.endMs <= now) return null;
  return match;
}

function assertPriceSane(valueWei, quantity, source, ceilingEth) {
  if (quantity <= 0) return;
  const perToken = Number(valueWei) / 1e18 / quantity;
  if (perToken > ceilingEth) {
    throw new Error(
      `Price sanity check failed: ${source} quoted ${perToken.toFixed(4)} ETH/token, ` +
      `above the configured ceiling of ${ceilingEth} ETH/token.`
    );
  }
}

function scaleGasByMultiplier(baselineWei, priorityFeePerGasWei, multiplier) {
  const scale = BigInt(Math.round(multiplier * 1000));
  const maxFeePerGas = (baselineWei * scale) / 1000n + priorityFeePerGasWei;
  const scaledPriority = (priorityFeePerGasWei * scale) / 1000n;
  return {
    maxFeePerGas,
    maxPriorityFeePerGas: scaledPriority > 0n ? scaledPriority : priorityFeePerGasWei
  };
}

function matchStageQuery(stageName, query) {
  if (!query) return false;
  return String(stageName || '').toLowerCase().includes(String(query).trim().toLowerCase());
}

module.exports = {
  extractSlugFromUrl,
  parseStageStartMs,
  stageLabel,
  stageTypeOf,
  normalizeDropStages,
  findUpcomingStages,
  findStageByLabel,
  assertPriceSane,
  scaleGasByMultiplier,
  matchStageQuery
};
