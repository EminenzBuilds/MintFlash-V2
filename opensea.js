const { ethers } = require('ethers');
const { config } = require('./config');
const { extractSlugFromUrl, findUpcomingStages, findStageByLabel } = require('./pure-helpers');

function headers() {
  if (!config.openseaApiKey) throw new Error('OPENSEA_API_KEY not configured');
  return { 'x-api-key': config.openseaApiKey, 'Content-Type': 'application/json' };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { res, body };
}

function mapChain(openseaChain) {
  return config.openseaChainAliases[String(openseaChain || '').toLowerCase()] || null;
}

async function fetchCollectionContracts(slug) {
  const { res, body } = await fetchJson(`https://api.opensea.io/api/v2/collections/${slug}`, {
    headers: headers()
  });
  if (res.status === 404) throw new Error('Collection slug not found on OpenSea');
  if (!res.ok) throw new Error(`Collection lookup failed: ${res.status}`);
  const contracts = body?.contracts || [];
  return contracts
    .map((c) => ({
      address: c.address,
      openseaChain: c.chain,
      chainKey: mapChain(c.chain)
    }))
    .filter((c) => c.address && c.chainKey && config.chains[c.chainKey]);
}

async function getDropInfo(slug) {
  const { res, body } = await fetchJson(`https://api.opensea.io/api/v2/drops/${slug}`, {
    headers: headers()
  });
  if (res.status === 404) throw new Error('Drop not found for this slug');
  if (!res.ok) throw new Error(`Drop lookup failed: ${res.status}`);
  return body;
}

function parseMintBuild(body) {
  const to = body?.to || body?.target;
  const data = body?.data || body?.calldata;
  if (!to || !data) throw new Error('OpenSea mint build missing to/data');
  return { to, data, value: BigInt(body.value || 0) };
}

async function buildOpenSeaMintTx(slug, minterAddress, quantity) {
  const { res, body } = await fetchJson(`https://api.opensea.io/api/v2/drops/${slug}/mint`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ minter: minterAddress, quantity })
  });

  if (res.status === 409) {
    const err = new Error(body?.error?.message || 'Drop not currently active');
    err.opensea409 = true;
    throw err;
  }
  if (res.status === 422) {
    const err = new Error(
      body?.error?.message || body?.errors?.[0] ||
      'Not eligible (allowlist, limit, balance, or supply)'
    );
    err.opensea422 = true;
    throw err;
  }
  if (!res.ok) throw new Error(`OpenSea mint build failed: ${res.status}`);
  return parseMintBuild(body);
}

async function collectionImage(slug) {
  try {
    const { res, body } = await fetchJson(`https://api.opensea.io/api/v2/collections/${slug}`, {
      headers: headers()
    });
    if (!res.ok) return null;
    return body?.image_url || body?.banner_image_url || null;
  } catch {
    return null;
  }
}

module.exports = {
  extractSlugFromUrl,
  fetchCollectionContracts,
  getDropInfo,
  buildOpenSeaMintTx,
  findUpcomingStages,
  findStageByLabel,
  collectionImage
};
