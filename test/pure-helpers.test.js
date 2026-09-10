const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractSlugFromUrl,
  findUpcomingStages,
  findStageByLabel,
  assertPriceSane,
  scaleGasByMultiplier
} = require('../lib/pure-helpers');

const ETH = 10n ** 18n;
const GWEI = 10n ** 9n;

test('extractSlugFromUrl', async (t) => {
  await t.test('simple slug', () => {
    assert.equal(extractSlugFromUrl('https://opensea.io/collection/cash-monkeysss'), 'cash-monkeysss');
  });
  await t.test('trailing path', () => {
    assert.equal(extractSlugFromUrl('https://opensea.io/collection/chiki-751329593/overview'), 'chiki-751329593');
  });
  await t.test('rejects non-OpenSea', () => {
    assert.equal(extractSlugFromUrl('https://example.com/collection/foo'), null);
  });
});

test('findUpcomingStages reads OpenSea label + start_time', async (t) => {
  const NOW = new Date('2026-08-19T12:00:00Z').getTime();
  const dropInfo = {
    stages: [
      { label: 'GTD', stage_type: 'signed_presale', start_time: '2026-08-19T11:00:00Z' },
      { label: 'Lucky List', stage_type: 'signed_presale', start_time: '2026-08-19T13:00:00Z' },
      { label: 'Public', stage_type: 'public_sale', start_time: '2026-08-19T15:00:00Z' }
    ]
  };
  await t.test('drops past stages and keeps labels', () => {
    const result = findUpcomingStages(dropInfo, NOW);
    assert.deepEqual(result.map((s) => s.name), ['Lucky List', 'Public']);
    assert.equal(result[0].stageType, 'signed_presale');
  });
  await t.test('findStageByLabel matches GTD even if past start but uses exact name', () => {
    const hit = findStageByLabel(dropInfo, 'lucky', NOW);
    assert.equal(hit.name, 'Lucky List');
  });
});

test('assertPriceSane', () => {
  assert.doesNotThrow(() => assertPriceSane(ETH / 10n, 1, 't', 0.5));
  assert.throws(() => assertPriceSane(ETH, 1, 't', 0.5), /Price sanity/);
});

test('scaleGasByMultiplier', () => {
  const baseline = 10n * GWEI;
  const priority = 1n * GWEI;
  const result = scaleGasByMultiplier(baseline, priority, 2.0);
  assert.equal(result.maxFeePerGas, 21n * GWEI);
  assert.equal(result.maxPriorityFeePerGas, 2n * GWEI);
});
