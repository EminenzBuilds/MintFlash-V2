const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { config } = require('./config');
const { getProvider } = require('./rpc');

const KEYSTORE_ROOT = path.join(config.dataDir, 'keystores');

class WalletLockedError extends Error {
  constructor(message = 'Wallet is locked — run /unlock first') {
    super(message);
    this.walletLocked = true;
  }
}

const unlocked = new Map();

function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(KEYSTORE_ROOT, { recursive: true, mode: 0o700 });
}

function userDir(userId) {
  return path.join(KEYSTORE_ROOT, String(userId));
}

function keystorePath(userId, address) {
  return path.join(userDir(userId), `${address.toLowerCase()}.json`);
}

function listStored(userId) {
  ensureDirs();
  const dir = userDir(userId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(dir, f);
      let address = f.replace(/\.json$/, '');
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (parsed.address) address = `0x${String(parsed.address).replace(/^0x/i, '')}`;
      } catch { /* use filename */ }
      try { address = ethers.getAddress(address); } catch { /* keep raw */ }
      return { address, path: full };
    });
}

function saveKeystore(userId, jsonText) {
  ensureDirs();
  const parsed = JSON.parse(jsonText);
  if (!(parsed.crypto || parsed.Crypto) || !parsed.version) {
    throw new Error('Not an Ethereum V3 keystore');
  }
  if (!parsed.address) throw new Error('Keystore missing address field');
  const address = ethers.getAddress(`0x${String(parsed.address).replace(/^0x/i, '')}`);
  const dir = userDir(userId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keystorePath(userId, address), jsonText, { mode: 0o600 });
  return address;
}

function removeKeystore(userId, address) {
  const stored = listStored(userId);
  const target = stored.find((s) => s.address.toLowerCase() === address.toLowerCase());
  if (!target) return false;
  fs.unlinkSync(target.path);
  const session = unlocked.get(String(userId));
  if (session) session.wallets.delete(ethers.getAddress(target.address));
  return true;
}

function hasStored(userId) {
  return listStored(userId).length > 0;
}

function getSession(userId) {
  return unlocked.get(String(userId));
}

function armAutoLock(userId, chatId, onLock) {
  const session = getSession(userId);
  if (!session) return;
  if (session.timeoutId) clearTimeout(session.timeoutId);
  session.timeoutId = setTimeout(() => {
    unlocked.delete(String(userId));
    if (onLock) onLock(chatId);
  }, config.autoLockMinutes * 60 * 1000);
  session.lockAt = Date.now() + config.autoLockMinutes * 60 * 1000;
  session.chatId = chatId;
}

async function unlockAll(userId, password, chatId, onLock) {
  const files = listStored(userId);
  if (!files.length) throw new Error('No keystore on file — upload one with /wallets');
  const wallets = new Map();
  const failed = [];
  for (const file of files) {
    try {
      const json = fs.readFileSync(file.path, 'utf8');
      const wallet = await ethers.Wallet.fromEncryptedJson(json, password);
      wallets.set(wallet.address, wallet);
    } catch {
      failed.push(file.address);
    }
  }
  if (!wallets.size) throw new Error('Password did not unlock any keystore');
  const prev = getSession(userId);
  if (prev?.timeoutId) clearTimeout(prev.timeoutId);
  unlocked.set(String(userId), { wallets, chatId, timeoutId: null, lockAt: null });
  armAutoLock(userId, chatId, onLock);
  return { addresses: [...wallets.keys()], failed };
}

function lock(userId) {
  const session = getSession(userId);
  if (!session) return false;
  if (session.timeoutId) clearTimeout(session.timeoutId);
  unlocked.delete(String(userId));
  return true;
}

function minutesUntilAutoLock(userId) {
  const session = getSession(userId);
  if (!session?.lockAt) return null;
  return (session.lockAt - Date.now()) / 60000;
}

function listUnlocked(userId) {
  const session = getSession(userId);
  if (!session) return [];
  return [...session.wallets.keys()];
}

function getUnlockedWallets(userId) {
  const session = getSession(userId);
  if (!session || !session.wallets.size) throw new WalletLockedError();
  return [...session.wallets.values()];
}

function connectWallet(wallet, chainKey) {
  return wallet.connect(getProvider(chainKey));
}

function unlockedCount() {
  return unlocked.size;
}

module.exports = {
  WalletLockedError,
  ensureDirs,
  listStored,
  saveKeystore,
  removeKeystore,
  hasStored,
  unlockAll,
  lock,
  minutesUntilAutoLock,
  listUnlocked,
  getUnlockedWallets,
  connectWallet,
  unlockedCount
};
