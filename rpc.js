const { ethers } = require('ethers');
const { config } = require('./config');
const { scaleGasByMultiplier } = require('./pure-helpers');

const providers = new Map();

function getProvider(chainKey) {
  if (providers.has(chainKey)) return providers.get(chainKey);
  const chain = config.chains[chainKey];
  if (!chain) throw new Error(`Unknown chain ${chainKey}`);
  if (!chain.rpcs.length) throw new Error(`No RPC configured for ${chain.name}`);

  const provider = chain.rpcs.length === 1
    ? new ethers.JsonRpcProvider(chain.rpcs[0], chain.chainId)
    : new ethers.FallbackProvider(
      chain.rpcs.map((url, i) => ({
        provider: new ethers.JsonRpcProvider(url, chain.chainId),
        priority: i + 1,
        stallTimeout: 400,
        weight: 1
      })),
      chain.chainId
    );

  providers.set(chainKey, provider);
  return provider;
}

async function assertChainId(chainKey) {
  const chain = config.chains[chainKey];
  const provider = getProvider(chainKey);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chain.chainId) {
    throw new Error(`RPC for ${chain.name} returned chainId ${network.chainId}, expected ${chain.chainId}`);
  }
}

async function getLiveGasOverrides(chainKey, presetName) {
  const chain = config.chains[chainKey];
  const profile = chain.gasProfile || 'priority';
  const table = config.gasMultipliers[profile];
  const multiplier = table[presetName] ?? table.normal;
  try {
    const feeData = await getProvider(chainKey).getFeeData();
    const baseline = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!baseline) throw new Error('no fee data');
    const priority = feeData.maxPriorityFeePerGas ?? ethers.parseUnits('0.1', 'gwei');
    return scaleGasByMultiplier(baseline, priority, multiplier);
  } catch (e) {
    const fallback = config.gasFallbackGwei[presetName] || config.gasFallbackGwei.normal;
    return {
      maxFeePerGas: ethers.parseUnits(String(fallback.maxFee), 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits(String(fallback.priority), 'gwei')
    };
  }
}

async function simulateCall(provider, tx) {
  await provider.call({
    from: tx.from,
    to: tx.to,
    data: tx.data || '0x',
    value: tx.value || 0n
  });
}

async function checkRpcHealth() {
  const results = [];
  for (const chainKey of Object.keys(config.chains)) {
    try {
      if (!config.chains[chainKey].rpcs.length) {
        results.push({ chainKey, ok: false, error: 'no RPC configured' });
        continue;
      }
      await getProvider(chainKey).getBlockNumber();
      results.push({ chainKey, ok: true });
    } catch (e) {
      results.push({ chainKey, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = {
  getProvider,
  assertChainId,
  getLiveGasOverrides,
  simulateCall,
  checkRpcHealth
};
