import { join } from "node:path";

/** Isolated test ports; never bind to or stop the existing development stack.
 * PORTEX_E2E_PORT_OFFSET shifts every port (and the scratch/build dirs) so parallel runs cannot collide. */
const OFFSET = Number(process.env.PORTEX_E2E_PORT_OFFSET ?? 0);
const SUFFIX = OFFSET ? `-${OFFSET}` : "";
export const ANVIL_PORT = 18550 + OFFSET;
export const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
export const API_PORT = 18791 + OFFSET;
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_PORT = 13100 + OFFSET;
export const TESTNET_WEB_PORT = 13102 + OFFSET;
export const TESTNET_WEB_URL = `http://localhost:${TESTNET_WEB_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

export const TMP_DIR = join(__dirname, `.tmp${SUFFIX}`) + "/";
export const BUILD_SUFFIX = SUFFIX;
export const PID_FILE = `${TMP_DIR}pids.json`;

/** Local test accounts (chain 31337), derived from the public test mnemonic; same order as the Dev page. */
export const ACCOUNTS = {
  deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  attester: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  council: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  builder: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  backer1: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  backer2: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  backer3: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  backer4: "0x14dC79964da2CedDb23698B31D228e232D10E062",
  backer5: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
  buyer: "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097",
  whale: "0xcd3B766CCDd6AE721141F452C550Ca635964ce71",
} as const;
