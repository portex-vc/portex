import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createConnector } from "wagmi";
import type { DevAccount } from "./api";
import { localAccounts } from "./local-dev";
import { localhost } from "./chains";
import { env } from "./env";

export const LOCAL_CONNECTOR_ID = "portex-local-accounts";

const STORAGE_KEY_INDEX = "portex.localAccountIndex";
const STORAGE_KEY_CONNECTED = "portex.localConnected";

function getStoredIndex(): number {
  if (typeof window === "undefined") return 3; // builder by default
  const raw = window.localStorage.getItem(STORAGE_KEY_INDEX);
  const n = raw === null ? 3 : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 15 ? n : 3;
}

/** In-memory copy of the selected account index, hydrated from localStorage on the client. */
let selectedIndex = typeof window === "undefined" ? 3 : getStoredIndex();

/** Cached copy of the local accounts, shared by the connector and the Dev page panel. */
let cachedAccounts: DevAccount[] | null = null;
let inflight: Promise<DevAccount[]> | null = null;

async function fetchLocalAccounts(): Promise<DevAccount[]> {
  if (cachedAccounts) return cachedAccounts;
  if (!inflight) {
    inflight = localAccounts().then((accounts) => {
      cachedAccounts = accounts;
      return accounts;
    });
  }
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Called when the user picks another account on the Dev page. */
export function setSelectedLocalAccountIndex(i: number) {
  selectedIndex = i;
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY_INDEX, String(i));
}

type Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (...args: unknown[]) => unknown;
  removeListener: (...args: unknown[]) => unknown;
};

type LocalConnectorProperties = {
  selectAccount: (index: number) => Promise<void>;
};

/**
 * Wagmi connector over the local test accounts (public test mnemonic, development only).
 * Registered only when the app chain is 31337. Transactions sign and send instantly, without prompts.
 */
export function localAccountsConnector() {
  return createConnector<Provider, LocalConnectorProperties>((config) => {
    const chain = config.chains[0] ?? localhost;

    async function resolveAccount(): Promise<DevAccount> {
      const accounts = await fetchLocalAccounts();
      const account = accounts.find((a) => a.index === selectedIndex) ?? accounts[0];
      if (!account) throw new Error("No local test accounts are available.");
      return account;
    }

    async function request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
      const account = await resolveAccount();
      const viemAccount = privateKeyToAccount(account.privateKey as Hex);
      const wallet = createWalletClient({ account: viemAccount, chain, transport: http(env.rpcLocal) });

      // Plain reads are forwarded to the local RPC.
      const rpc = http(env.rpcLocal)({ chain });
      const forward = () => rpc.request({ method, params } as never);

      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [viemAccount.address];
        case "eth_chainId":
          return `0x${chain.id.toString(16)}`;
        case "net_version":
          return String(chain.id);
        case "personal_sign": {
          const [data] = params as [Hex, Address];
          return viemAccount.signMessage({ message: { raw: data } });
        }
        case "eth_signTypedData_v4": {
          const [, typedDataJson] = params as [Address, string];
          const typedData = JSON.parse(typedDataJson);
          return viemAccount.signTypedData({
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message,
          });
        }
        case "eth_sendTransaction": {
          const [tx] = params as [{ to?: Address; data?: Hex; value?: Hex }];
          return wallet.sendTransaction({
            to: tx.to,
            data: tx.data ?? "0x",
            value: tx.value ? BigInt(tx.value) : undefined,
          });
        }
        case "wallet_switchEthereumChain": {
          const [{ chainId }] = params as [{ chainId: string }];
          if (Number(chainId) !== chain.id) {
            throw new Error("Local test accounts only support the local chain (31337).");
          }
          return null;
        }
        default:
          return forward();
      }
    }

    const provider: Provider = {
      request,
      on: () => provider,
      removeListener: () => provider,
    };

    return {
      id: LOCAL_CONNECTOR_ID,
      name: "Local test account",
      type: "portex-local-accounts",

      async connect() {
        if (env.chainId !== 31337) {
          throw new Error("Local test accounts are only available on the local chain (31337).");
        }
        const account = await resolveAccount();
        if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY_CONNECTED, "1");
        return {
          accounts: [account.address as Address],
          chainId: chain.id,
        } as never;
      },

      async disconnect() {
        if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY_CONNECTED);
      },

      async getAccounts() {
        const account = await resolveAccount();
        return [account.address as Address];
      },

      async getChainId() {
        return chain.id;
      },

      async getProvider() {
        return provider;
      },

      async isAuthorized() {
        if (env.chainId !== 31337) return false;
        if (typeof window === "undefined") return false;
        if (window.localStorage.getItem(STORAGE_KEY_CONNECTED) !== "1") return false;
        try {
          await resolveAccount();
          return true;
        } catch {
          return false;
        }
      },

      async switchChain({ chainId }) {
        if (chainId !== chain.id) {
          throw new Error("Local test accounts only support the local chain (31337).");
        }
        return chain;
      },

      onAccountsChanged(accounts) {
        if (accounts.length === 0) config.emitter.emit("disconnect");
      },
      onChainChanged() {},
      onDisconnect() {},

      /** Custom property: switch the active local account and notify wagmi. */
      async selectAccount(index: number) {
        setSelectedLocalAccountIndex(index);
        const account = await resolveAccount();
        config.emitter.emit("change", { accounts: [account.address as Address] });
      },
    };
  });
}
