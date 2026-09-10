const { ethers } = require('ethers');
const { config } = require('./config');
const { assertPriceSane: assertPriceSaneCore } = require('./pure-helpers');
const { getProvider, getLiveGasOverrides, simulateCall } = require('./rpc');
const { WalletLockedError, getUnlockedWallets, connectWallet } = require('./wallets');
const { buildOpenSeaMintTx } = require('./opensea');

const SEADROP_ABI = [
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])'
];

const NFT_ABI = [
  'function mint(uint256 quantity) payable',
  'function mint(address to, uint256 quantity) payable',
  'function publicMint(uint256 quantity) payable',
  'function claim(uint256 quantity) payable'
];

const PRICE_VIEWS = ['price', 'mintPrice', 'cost', 'PRICE', 'getPrice'];

const sendQueues = new Map();

function withWalletLock(address, fn) {
  const key = address.toLowerCase();
  const prior = sendQueues.get(key) || Promise.resolve();
  const run = prior.then(fn, fn);
  sendQueues.set(key, run.then(() => {}, () => {}));
  return run;
}

function errReason(e) {
  return e?.reason || e?.shortMessage || e?.info?.error?.message || e?.message || 'Unknown error';
}

function assertPriceSane(valueWei, quantity, source) {
  return assertPriceSaneCore(valueWei, quantity, source, config.maxPricePerTokenEth);
}

async function buildOverrides(intent) {
  const overrides = {};
  if (intent.gasPreset === 'custom') {
    overrides.maxFeePerGas = ethers.parseUnits(String(intent.customMaxFee), 'gwei');
    overrides.maxPriorityFeePerGas = ethers.parseUnits(String(intent.customPriority), 'gwei');
  } else {
    const live = await getLiveGasOverrides(intent.chain, intent.gasPreset || 'fast');
    overrides.maxFeePerGas = live.maxFeePerGas;
    overrides.maxPriorityFeePerGas = live.maxPriorityFeePerGas;
  }
  overrides.gasLimit = 150_000n * BigInt(intent.quantity) + 150_000n;
  return overrides;
}

async function assertSufficientBalance(wallet, value, overrides) {
  const balance = await wallet.provider.getBalance(wallet.address);
  const gasBuffer = (overrides.maxFeePerGas || 0n) * (overrides.gasLimit || 300_000n);
  const required = value + gasBuffer;
  if (balance < required) {
    throw new Error(
      `Insufficient balance: need ~${ethers.formatEther(required)} ETH, have ${ethers.formatEther(balance)} ETH`
    );
  }
}

async function sendRaw(wallet, txRequest, overrides) {
  const populated = {
    from: wallet.address,
    to: txRequest.to,
    data: txRequest.data,
    value: txRequest.value || 0n,
    ...overrides
  };
  await simulateCall(wallet.provider, populated);
  await assertPriceSane(populated.value || 0n, txRequest.quantity || 1, txRequest.source || 'tx');
  await assertSufficientBalance(wallet, populated.value || 0n, overrides);
  return wallet.sendTransaction({
    to: populated.to,
    data: populated.data,
    value: populated.value,
    maxFeePerGas: overrides.maxFeePerGas,
    maxPriorityFeePerGas: overrides.maxPriorityFeePerGas,
    gasLimit: overrides.gasLimit
  });
}

async function tryOpenSea(intent, wallet, overrides, errors) {
  if (!intent.openseaSlug) return null;
  if (!config.openseaApiKey) {
    errors.push('OpenSea: no API key');
    return null;
  }
  try {
    const built = intent.prebuiltByWallet?.[wallet.address.toLowerCase()]
      || await buildOpenSeaMintTx(intent.openseaSlug, wallet.address, intent.quantity);
    const tx = await sendRaw(wallet, {
      to: built.to,
      data: built.data,
      value: built.value,
      quantity: intent.quantity,
      source: 'OpenSea Drops API'
    }, overrides);
    return { tx, usedMethod: `OpenSea Drops (${intent.openseaSlug})` };
  } catch (e) {
    errors.push(`OpenSea: ${errReason(e)}`);
    return null;
  }
}

async function checkSeaDropDeployed(chainKey) {
  try {
    const code = await getProvider(chainKey).getCode(config.seadropAddress);
    return code !== '0x';
  } catch {
    return null;
  }
}

function allowPublicFallback(intent) {
  const type = String(intent.stageType || '').toLowerCase();
  const name = String(intent.stageName || '').toLowerCase();
  if (type === 'public_sale' || name.includes('public')) return true;
  if (!intent.openseaSlug) return true;
  return false;
}

async function trySeaDropPublic(intent, wallet, overrides, errors) {
  if (!allowPublicFallback(intent)) {
    errors.push('SeaDrop public skipped — this job is an allowlist/GTD stage');
    return null;
  }
  const deployed = await checkSeaDropDeployed(intent.chain);
  if (deployed === false) {
    errors.push(`SeaDrop: not deployed on ${config.chains[intent.chain].name}`);
    return null;
  }
  const seaDrop = new ethers.Contract(config.seadropAddress, SEADROP_ABI, wallet);
  let drop;
  try {
    drop = await seaDrop.getPublicDrop(intent.contract);
  } catch (e) {
    errors.push(`SeaDrop.getPublicDrop: ${errReason(e)}`);
    return null;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Number(drop.startTime) === 0 && Number(drop.endTime) === 0) {
    errors.push('SeaDrop: no public stage');
    return null;
  }
  if (nowSec < Number(drop.startTime)) {
    errors.push(`SeaDrop: public not open yet`);
    return null;
  }
  if (nowSec > Number(drop.endTime)) {
    errors.push('SeaDrop: public already ended');
    return null;
  }

  let feeRecipient = ethers.ZeroAddress;
  if (drop.restrictFeeRecipients) {
    const allowed = await seaDrop.getAllowedFeeRecipients(intent.contract);
    if (!allowed?.length) {
      errors.push('SeaDrop: no allowed fee recipient');
      return null;
    }
    feeRecipient = allowed[0];
  }

  const value = BigInt(drop.mintPrice) * BigInt(intent.quantity);
  const data = seaDrop.interface.encodeFunctionData('mintPublic', [
    intent.contract,
    feeRecipient,
    wallet.address,
    intent.quantity
  ]);
  try {
    const tx = await sendRaw(wallet, {
      to: config.seadropAddress,
      data,
      value,
      quantity: intent.quantity,
      source: 'SeaDrop.mintPublic'
    }, overrides);
    return { tx, usedMethod: 'SeaDrop.mintPublic' };
  } catch (e) {
    errors.push(`SeaDrop.mintPublic: ${errReason(e)}`);
    return null;
  }
}

async function discoverPrice(contractAddress, wallet) {
  const abi = PRICE_VIEWS.map((fn) => `function ${fn}() view returns (uint256)`);
  const c = new ethers.Contract(contractAddress, abi, wallet);
  for (const fn of PRICE_VIEWS) {
    try {
      const p = await c[fn]();
      return { price: BigInt(p), source: `${fn}()` };
    } catch { /* next */ }
  }
  return { price: null, source: null };
}

async function tryNormalMints(intent, wallet, overrides, errors) {
  let value = 0n;
  let priceSource = 'assumed free';
  if (intent.manualPriceEth != null) {
    value = ethers.parseEther(String(intent.manualPriceEth)) * BigInt(intent.quantity);
    priceSource = `manual ${intent.manualPriceEth} ETH`;
  } else {
    const found = await discoverPrice(intent.contract, wallet);
    if (found.price != null) {
      value = found.price * BigInt(intent.quantity);
      priceSource = found.source;
    }
  }

  const nft = new ethers.Contract(intent.contract, NFT_ABI, wallet);
  const attempts = [
    { sig: 'mint(uint256)', args: [intent.quantity] },
    { sig: 'mint(address,uint256)', args: [wallet.address, intent.quantity] },
    { sig: 'publicMint(uint256)', args: [intent.quantity] },
    { sig: 'claim(uint256)', args: [intent.quantity] }
  ];

  for (const attempt of attempts) {
    try {
      const data = nft.interface.encodeFunctionData(attempt.sig, attempt.args);
      const tx = await sendRaw(wallet, {
        to: intent.contract,
        data,
        value,
        quantity: intent.quantity,
        source: `NFT.${attempt.sig} (${priceSource})`
      }, overrides);
      return { tx, usedMethod: `NFT.${attempt.sig}` };
    } catch (e) {
      errors.push(`NFT.${attempt.sig}: ${errReason(e)}`);
    }
  }
  return null;
}

function summarizeFailure(errors) {
  const combined = errors.join(' | ').toLowerCase();
  if (combined.includes('insufficient balance') || combined.includes('insufficient funds')) {
    return '❌ Insufficient ETH balance.';
  }
  if (combined.includes('price sanity')) return '❌ Quoted price is above the safety ceiling.';
  if (combined.includes('not currently active') || combined.includes('not open')) {
    return '❌ Mint is not open yet.';
  }
  if (combined.includes('allowlist') || combined.includes('not eligible')) {
    return '❌ Wallet is not eligible for the current stage.';
  }
  if (combined.includes('wallet locked')) return `❌ ${errors[errors.length - 1]}`;
  const line = errors.find((e) => !/skipped|assumed free/i.test(e)) || errors[errors.length - 1] || 'unknown error';
  return `❌ Mint failed: ${line}`;
}

async function mintOneWallet(intent, baseWallet) {
  const errors = [];
  const wallet = connectWallet(baseWallet, intent.chain);
  const overrides = await buildOverrides(intent);

  return withWalletLock(wallet.address, async () => {
    let result = null;
    if (intent.openseaSlug) {
      result = await tryOpenSea(intent, wallet, overrides, errors);
      if (!result && allowPublicFallback(intent)) {
        result = await trySeaDropPublic(intent, wallet, overrides, errors);
      }
    } else {
      result = await trySeaDropPublic(intent, wallet, overrides, errors);
      if (!result) result = await tryNormalMints(intent, wallet, overrides, errors);
    }
    return { wallet, result, errors };
  });
}

async function performMint(intent) {
  let wallets;
  try {
    wallets = getUnlockedWallets(intent.userId);
  } catch (e) {
    if (e.walletLocked) throw e;
    throw e;
  }
  if (intent.addresses?.length) {
    const allow = new Set(intent.addresses.map((a) => a.toLowerCase()));
    wallets = wallets.filter((w) => allow.has(w.address.toLowerCase()));
  }
  if (!wallets.length) throw new WalletLockedError('No unlocked wallet available for this mint');

  const outcomes = [];
  for (const wallet of wallets) {
    outcomes.push(await mintOneWallet(intent, wallet));
  }
  return outcomes;
}

async function checkEligibility(slug, address) {
  try {
    await buildOpenSeaMintTx(slug, address, 1);
    return { ok: true, status: 'eligible', detail: 'Eligible right now' };
  } catch (e) {
    if (e.opensea409) return { ok: false, status: 'inactive', detail: errReason(e) };
    if (e.opensea422) return { ok: false, status: 'ineligible', detail: errReason(e) };
    return { ok: false, status: 'unknown', detail: errReason(e) };
  }
}

module.exports = {
  errReason,
  buildOverrides,
  performMint,
  checkEligibility,
  checkSeaDropDeployed,
  summarizeFailure,
  allowPublicFallback
};
