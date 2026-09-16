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
  // If the ticker already fetched gas during the hot window (allowlist
  // path) or right before signing (public pre-sign path), use that instead
  // of fetching again — one less RPC round-trip sitting between "we know
  // we can mint" and "transaction sent".
  if (intent.prefetchedOverrides) return intent.prefetchedOverrides;

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

// --- Direct public-stage path only ---
//
// Unlike the OpenSea/allowlist path, everything needed for a direct public
// SeaDrop mint is knowable from chain state alone (price, timing, fee
// recipient) — nothing here depends on a third party's timing.
//
// Signing happens ONLY at T0, not ahead of time. Signing itself is fast
// (sub-millisecond, pure local math) — pre-signing bought negligible speed
// while risking a stale nonce/gas if conditions shifted between an earlier
// signature and the actual broadcast moment. A tight final state check
// immediately before signing is both simpler and safer.
//
// NOTE: this is architecturally sound but has not been exercised against a
// live chain in this environment — verify with a real (ideally low-stakes)
// public mint before trusting it on something competitive.

async function readPublicDropInfo(intent, wallet) {
  const seaDrop = new ethers.Contract(config.seadropAddress, SEADROP_ABI, wallet);
  const drop = await seaDrop.getPublicDrop(intent.contract);

  if (Number(drop.startTime) === 0 && Number(drop.endTime) === 0) {
    throw new Error('SeaDrop: no public stage configured for this contract');
  }

  let feeRecipient = ethers.ZeroAddress;
  if (drop.restrictFeeRecipients) {
    const allowed = await seaDrop.getAllowedFeeRecipients(intent.contract);
    if (!allowed?.length) throw new Error('SeaDrop: no allowed fee recipient');
    feeRecipient = allowed[0];
  }

  const value = BigInt(drop.mintPrice) * BigInt(intent.quantity);
  const data = seaDrop.interface.encodeFunctionData('mintPublic', [
    intent.contract,
    feeRecipient,
    wallet.address,
    intent.quantity
  ]);

  return { startTime: Number(drop.startTime), endTime: Number(drop.endTime), value, data };
}

// Resolves which wallets a ticker job should act on — read-only, no
// signing. Used both to discover the real on-chain start time (ticker.js's
// discovery phase, which can happen repeatedly and harmlessly) and, later,
// as the target list for the actual T0 fire.
function getWalletsForIntent(intent) {
  const allWallets = getUnlockedWallets(intent.userId); // throws WalletLockedError if none
  const allow = intent.addresses?.length
    ? new Set(intent.addresses.map((a) => a.toLowerCase()))
    : null;
  const targets = allow ? allWallets.filter((w) => allow.has(w.address.toLowerCase())) : allWallets;
  return targets.map((w) => connectWallet(w, intent.chain));
}

const REPLACEMENT_CONFIRM_TIMEOUT_MS = 8000; // how long to wait before assuming a send is stuck
const MAX_REPLACEMENTS = 3;
const REPLACEMENT_BUMP = 1.3; // +30% per bump — comfortably above the ~10% minimum most nodes require to accept a same-nonce replacement
const FINAL_WAIT_TIMEOUT_MS = 60_000; // bounded even after replacements are exhausted, so this can never hang forever

// The actual T0 action for one wallet: final fresh state check (price,
// balance, gas, nonce — all re-read right here, nothing reused from
// earlier), sign, broadcast. If the transaction doesn't confirm within
// REPLACEMENT_CONFIRM_TIMEOUT_MS, resubmits with the same nonce and a
// bumped fee (standard replace-by-fee) up to MAX_REPLACEMENTS times before
// falling back to one longer, still-bounded wait for whichever attempt
// actually lands.
async function fireDirectPublicMint(intent, wallet) {
  return withWalletLock(wallet.address, async () => {
    const dropInfo = await readPublicDropInfo(intent, wallet);
    const overrides = await buildOverrides(intent);

    await assertPriceSane(dropInfo.value, intent.quantity, 'SeaDrop.mintPublic');
    await assertSufficientBalance(wallet, dropInfo.value, overrides);

    const nonce = await wallet.provider.getTransactionCount(wallet.address, 'pending');
    let txParams = {
      to: config.seadropAddress,
      data: dropInfo.data,
      value: dropInfo.value,
      nonce,
      maxFeePerGas: overrides.maxFeePerGas,
      maxPriorityFeePerGas: overrides.maxPriorityFeePerGas,
      gasLimit: overrides.gasLimit
    };

    let tx = await wallet.sendTransaction(txParams);
    let replacements = 0;

    while (replacements < MAX_REPLACEMENTS) {
      try {
        const receipt = await tx.wait(1, REPLACEMENT_CONFIRM_TIMEOUT_MS);
        return { tx, receipt, replacements };
      } catch (e) {
        if (e.code !== 'TIMEOUT') throw e; // a real failure (revert, etc.) — surface it, don't mask it as "stuck"
        replacements++;
        txParams = {
          ...txParams,
          maxFeePerGas: (txParams.maxFeePerGas * BigInt(Math.round(REPLACEMENT_BUMP * 100))) / 100n,
          maxPriorityFeePerGas: (txParams.maxPriorityFeePerGas * BigInt(Math.round(REPLACEMENT_BUMP * 100))) / 100n
        };
        tx = await wallet.sendTransaction(txParams); // same nonce — a valid node accepts this as a replacement
      }
    }

    // Replacements exhausted — one more bounded wait for whichever attempt
    // actually lands, rather than an unbounded wait that could hang forever
    // (ethers has a known issue where wait() doesn't always cleanly detect
    // a transaction that was replaced by a different one sharing its nonce).
    const receipt = await tx.wait(1, FINAL_WAIT_TIMEOUT_MS);
    return { tx, receipt, replacements };
  });
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

  // Generic fallback chain (e.g. SeaDrop tried and failed, then plain
  // mint()/publicMint()/claim() guesses tried too). The FIRST error here is
  // near-always SeaDrop's "no public stage" / "not deployed" on a
  // non-SeaDrop contract — expected, uninteresting noise, not the real
  // signal. Showing that instead of what the actual mint attempts reported
  // is actively misleading, not just less informative — filter it out and
  // surface the LAST real attempt's reason, since that's the most
  // conclusive one tried. Always show the attempt count too, so a
  // multi-attempt failure is never mistaken for a single clean reason.
  const meaningful = errors.filter((e) => !/no public stage|not deployed on|skipped|assumed free/i.test(e));
  const line = meaningful[meaningful.length - 1] || errors[errors.length - 1] || 'unknown error';
  const suffix = errors.length > 1 ? ` (${errors.length} attempts tried — see logs for all)` : '';
  return `❌ Mint failed: ${line}${suffix}`;
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
      // Raw contract address, no OpenSea link — in practice this is most
      // often a custom/non-SeaDrop mint (a "mint from website" contract),
      // so try the generic mint()/publicMint()/claim() guesses FIRST. This
      // is safe here specifically because sendRaw always simulates (eth_call)
      // before ever broadcasting — a wrong guess fails via a cheap read, not
      // a wasted real transaction, unlike v1's architecture where guess
      // order genuinely risked burning a real transaction on a bad guess.
      // If you paste a raw SeaDrop address directly (rather than using the
      // OpenSea link, which already tries SeaDrop-aware logic first), this
      // costs a few extra read-only calls before reaching the correct
      // SeaDrop call — slower in that narrower case, never costlier.
      result = await tryNormalMints(intent, wallet, overrides, errors);
      if (!result) result = await trySeaDropPublic(intent, wallet, overrides, errors);
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
  allowPublicFallback,
  readPublicDropInfo,
  getWalletsForIntent,
  fireDirectPublicMint
};
