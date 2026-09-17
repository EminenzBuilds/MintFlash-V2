require('dotenv').config();
const path = require('path');

function splitIds(value) {
  return String(value || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

const ALLOW_PUBLIC = String(process.env.ALLOW_PUBLIC || '').toLowerCase() === 'true';
const ALLOWED_USERS = splitIds(process.env.ALLOWED_USER_IDS);

const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  openseaApiKey: process.env.OPENSEA_API_KEY || null,
  allowPublic: ALLOW_PUBLIC,
  allowedUsers: ALLOWED_USERS,
  ownerChatId: process.env.OWNER_CHAT_ID || null,
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  autoLockMinutes: process.env.AUTO_LOCK_MINUTES !== undefined ? Number(process.env.AUTO_LOCK_MINUTES) : 90,
  maxPricePerTokenEth: process.env.MAX_PRICE_PER_TOKEN_ETH !== undefined ? Number(process.env.MAX_PRICE_PER_TOKEN_ETH) : 0.5,
  scheduleTzOffset: process.env.SCHEDULE_TZ_OFFSET || '+01:00',
  hotWindowMs: process.env.HOT_WINDOW_MS !== undefined ? Number(process.env.HOT_WINDOW_MS) : 30_000,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 200,
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
  port: Number(process.env.PORT) || 3000,
  seadropAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  chains: {
    eth: {
      name: 'Ethereum',
      chainId: 1,
      rpcs: [process.env.ETH_RPC_URL, process.env.ETH_RPC_URL_BACKUP].filter(Boolean),
      explorer: 'https://etherscan.io/tx/',
      gasProfile: 'priority'
    },
    robinhood: {
      name: 'Robinhood Chain',
      chainId: 4663,
      rpcs: [process.env.ROBINHOOD_RPC_URL, process.env.ROBINHOOD_RPC_URL_BACKUP].filter(Boolean),
      explorer: 'https://robinhoodchain.blockscout.com/tx/',
      gasProfile: 'arrival'
    }
  },
  openseaChainAliases: {
    ethereum: 'eth',
    eth: 'eth',
    mainnet: 'eth',
    robinhood: 'robinhood',
    robinhood_chain: 'robinhood',
    'robinhood-chain': 'robinhood',
    robinhoodchain: 'robinhood',
    rh: 'robinhood',
    hood: 'robinhood'
  },
  gasMultipliers: {
    priority: { slow: 1.0, normal: 1.25, fast: 1.6, instant: 2.5, aggressive: 5.0 },
    arrival: { slow: 1.0, normal: 1.05, fast: 1.1, instant: 1.15, aggressive: 1.2 }
  },
  gasFallbackGwei: {
    slow: { maxFee: 0.5, priority: 0.1 },
    normal: { maxFee: 1, priority: 0.2 },
    fast: { maxFee: 3, priority: 0.5 },
    instant: { maxFee: 10, priority: 1 },
    aggressive: { maxFee: 30, priority: 2 }
  }
};

config.keystorePageUrl = config.publicUrl ? `${config.publicUrl}/keystore` : null;

function assertStartupConfig() {
  if (!config.botToken) {
    console.error('Missing TELEGRAM_BOT_TOKEN');
    process.exit(1);
  }
  if (!config.allowPublic && config.allowedUsers.length === 0) {
    console.error('Set ALLOWED_USER_IDS or ALLOW_PUBLIC=true');
    process.exit(1);
  }
  if (!config.openseaApiKey) {
    console.warn('OPENSEA_API_KEY missing — OpenSea drop lookup and builder disabled.');
  }
  if (!process.env.DATA_DIR) {
    console.warn('DATA_DIR not set — data lives next to the code and can vanish on redeploy.');
  }
}

module.exports = { config, assertStartupConfig };
