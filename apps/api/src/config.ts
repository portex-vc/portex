/** Environment-driven configuration with X Layer testnet defaults. */

// anvil account #1 — the attester account used by scripts/deploy-local.sh (localhost only).
export const ANVIL_ATTESTER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
// anvil account #0 — deployer; used by localhost dev endpoints (faucet native top-up).
export const ANVIL_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

export const ANVIL_ACCOUNTS: { address: string; privateKey: string; label: string }[] = [
  { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', label: 'deployer/curator' },
  { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', label: 'attester' },
  { address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', privateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', label: 'council' },
  { address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', privateKey: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', label: 'builder' },
  { address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', privateKey: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', label: 'backer 1' },
  { address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', privateKey: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', label: 'backer 2' },
  { address: '0x976EA74026E726554dB657fA54763abd0C3a0aa9', privateKey: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', label: 'backer 3' },
  { address: '0x14dC79964da2CedDb23698B31D228e232D10E062', privateKey: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356', label: 'backer 4' },
  { address: '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f', privateKey: '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', label: 'backer 5' },
  { address: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720', privateKey: '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', label: 'whale' },
];

function num(v: string | undefined, dflt: number): number {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('Invalid numeric environment value');
  return n;
}

export interface Config {
  chainId: number;
  rpcUrl: string;
  confirmations: number;
  pollMs: number;
  logPage: number;
  port: number;
  corsOrigins: string[];
  databasePath: string;
  publicApiUrl: string;
  adminAddresses: string[];
  attesterPrivateKey: `0x${string}` | null;
  anthropicApiKey: string | null;
  analystModel: string;
  analystIntervalMs: number;
  isLocal: boolean;
  /** Pinata JWT for image uploads (server env only; never logged). Null = local upload storage. */
  pinataJwt?: string | null;
  /** Public IPFS gateway origin used to resolve ipfs:// images (default https://gateway.pinata.cloud). */
  pinataGateway?: string | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const chainId = num(env.PORTEX_CHAIN_ID, 1952);
  if (![1952, 196, 31337].includes(chainId)) throw new Error('Unsupported PORTEX_CHAIN_ID');
  const isLocal = chainId === 31337;
  const network = chainId === 196 ? 'mainnet' : 'testnet';
  const rpcUrl = env.RPC_URL || (isLocal ? 'http://127.0.0.1:8545' : env.ALCHEMY_API_KEY
    ? `https://xlayer-${network}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`
    : chainId === 196 ? 'https://rpc.xlayer.tech' : 'https://testrpc.xlayer.tech/terigon');
  const attesterPrivateKey =
    (env.ATTESTER_PRIVATE_KEY as `0x${string}` | undefined) ||
    (isLocal ? ANVIL_ATTESTER_KEY : null);
  return {
    chainId,
    rpcUrl,
    confirmations: num(env.CONFIRMATIONS, 0),
    pollMs: num(env.POLL_MS, 1000),
    logPage: num(env.LOG_PAGE, 1000),
    port: num(env.PORT, 8790),
    corsOrigins: (env.CORS_ORIGINS || 'http://localhost:3100')
      .split(',').map((s) => s.trim()).filter(Boolean),
    databasePath: env.DATABASE_PATH || `./data/portex-${chainId}.db`,
    publicApiUrl: (env.PUBLIC_API_URL || 'http://localhost:8790').replace(/\/$/, ''),
    adminAddresses: (env.ADMIN_ADDRESSES || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    attesterPrivateKey,
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    analystModel: env.ANALYST_MODEL || 'claude-sonnet-5',
    analystIntervalMs: num(env.ANALYST_INTERVAL_MS, 0),
    isLocal,
    pinataJwt: env.PINATA_JWT || null,
    pinataGateway: env.PINATA_GATEWAY || null,
  };
}

export const config = loadConfig();
