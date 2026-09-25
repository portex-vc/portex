import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Address } from "viem";
import type { ApiConfig, RaiseSummary } from "../src/lib/api";
import { erc20Abi } from "../src/lib/contracts";
import { ANVIL_PORT, API_URL, RPC_URL, TESTNET_WEB_URL } from "./env";
import { actor, api, client, connectAs, indexed } from "./helpers";

/**
 * Founder rule: the browser never exposes a keyed RPC endpoint, and displayed data comes from the Portex API. While
 * browsing, the page makes no RPC request at all. While a transaction is in flight, the testnet build sends its
 * simulate, gas-estimate and receipt calls to X Layer's keyless public RPC (a browser wallet's own node connection
 * can stall them without showing a prompt); the local build hands them to its burner wallet.
 *
 * Every request of the browser context is recorded while every route is visited (disconnected, and connected as a
 * backer and as the builder), and while a transaction is signed. A request counts as RPC when its body is JSON-RPC
 * (`"jsonrpc"`) or it goes to a known RPC host (the X Layer RPCs or the local node).
 *
 * The single exclusion: the local burner wallet (chain 31337 builds only) is itself a wallet that runs inside the
 * page, so the calls a wallet answers (signing and sending, plus the simulate, gas and receipt calls the app hands
 * to any wallet) leave the page as HTTP to the local node. They carry `?source=portex-local-wallet`
 * (`src/lib/local-connector.ts`), and only those are excluded, and only while a transaction is in flight. While
 * browsing, even the burner wallet must send nothing. On the testnet build a browser wallet stands in whose node
 * traffic stays outside the page (as an extension's does), so there nothing at all is allowed.
 */

const RPC_HOSTS = [
  "testrpc.xlayer.tech",
  "rpc.xlayer.tech",
  "xlayerrpc.okx.com",
  `127.0.0.1:${ANVIL_PORT}`,
  `localhost:${ANVIL_PORT}`,
];
const LOCAL_WALLET_TAG = "source=portex-local-wallet";
/** X Layer's keyless public RPCs, and the only calls the testnet build may send them while a transaction is in flight. */
const PUBLIC_RPC_HOSTS = ["testrpc.xlayer.tech", "xlayertestrpc.okx.com", "rpc.xlayer.tech", "xlayerrpc.okx.com"];
const TX_METHODS = [
  "eth_call",
  "eth_estimateGas",
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
];

interface RpcHit {
  route: string;
  url: string;
  methods: string[];
  localWallet: boolean;
}

function methodsOf(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { method?: string } | { method?: string }[];
    return (Array.isArray(parsed) ? parsed : [parsed]).map((call) => call.method ?? "?");
  } catch {
    return [];
  }
}

/** Records every RPC-shaped request (HTTP or WebSocket) the browser context makes. */
function recordRpc(context: BrowserContext) {
  const hits: RpcHit[] = [];
  let route = "(setup)";
  const isRpcHost = (url: string) => {
    try {
      const host = new URL(url).host;
      return RPC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  };
  context.on("request", (request) => {
    const url = request.url();
    const body = request.postData() ?? "";
    if (!isRpcHost(url) && !/"jsonrpc"\s*:/.test(body)) return;
    hits.push({ route, url, methods: methodsOf(body), localWallet: url.includes(LOCAL_WALLET_TAG) });
  });
  const watchSockets = (page: Page) =>
    page.on("websocket", (socket) => {
      if (isRpcHost(socket.url())) hits.push({ route, url: socket.url(), methods: ["websocket"], localWallet: false });
    });
  context.pages().forEach(watchSockets);
  context.on("page", watchSockets);
  return {
    hits,
    at(next: string) {
      route = next;
    },
    since(start: number) {
      return hits.slice(start);
    },
  };
}

/** Every page of the app on the seeded stack: each static route, and every raise's four tabs and manage page. */
async function everyRoute(): Promise<string[]> {
  const raises = await api<RaiseSummary[]>("/raises");
  const routes = ["/", "/markets", "/portfolio", "/protocol", "/create", "/docs", "/wiki", "/admin", "/dev"];
  for (const r of raises) {
    for (const tab of ["overview", "market", "governance", "activity"]) routes.push(`/raise/${r.address}?tab=${tab}`);
    routes.push(`/raise/${r.address}/manage`);
  }
  for (const r of raises.filter((x) => x.phase === "Stage3")) routes.push(`/markets/${r.address}`);
  return routes;
}

async function visitAll(page: Page, base: string, routes: string[], recorder: ReturnType<typeof recordRpc>) {
  for (const route of routes) {
    recorder.at(`${base}${route}`);
    await page.goto(`${base}${route}`);
    // Queries fire when the page mounts. Pages that poll every few seconds may never reach network idle, so wait
    // for it only briefly, then stay one more beat to catch the first round of the shortest polling intervals.
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }
  recorder.at("(idle)");
}

const describe = (hits: RpcHit[]) => hits.map((h) => `${h.route} → ${h.url} ${h.methods.join(",")}`);

test("No RPC — local build: every route, disconnected, as a backer and as the builder", async ({ page, context }) => {
  test.setTimeout(25 * 60 * 1000);
  const recorder = recordRpc(context);
  const routes = await everyRoute();

  await visitAll(page, "", routes, recorder);
  expect(describe(recorder.hits), "disconnected: no RPC at all").toEqual([]);

  for (const [index, role] of [
    [4, "backer"],
    [3, "builder"],
  ] as const) {
    const start = recorder.hits.length;
    await connectAs(page, index);
    await visitAll(page, "", routes, recorder);
    // Browsing sends nothing, not even through the burner wallet.
    expect(describe(recorder.since(start)), `connected as ${role}: no RPC at all`).toEqual([]);
  }
});

test("No RPC — local build: a transaction simulates, estimates and confirms only through the wallet", async ({
  page,
  context,
}) => {
  const recorder = recordRpc(context);
  const index = 10; // Backer 7: not used by the flow specs, and a mint only raises its balance.
  await page.goto("/dev");
  const before = (await client.readContract({
    address: (await api<ApiConfig>("/config")).quote.address as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [actor(index).address],
  })) as bigint;
  await connectAs(page, index);
  recorder.at("/dev mint");
  const start = recorder.hits.length;
  await page.getByTestId("dev-mint").click();
  await page.getByTestId("confirm-transaction").click();
  await expect(page.getByTestId("transaction-drawer")).toHaveAttribute("data-status", "confirmed", { timeout: 45_000 });
  const during = recorder.since(start);
  // Everything that reached the node was the wallet's own traffic…
  expect(describe(during.filter((h) => !h.localWallet)), "app-originated RPC during a transaction").toEqual([]);
  // …and it carried the simulate, the gas estimate (for the 1.5x margin), the send and the receipt wait.
  const methods = new Set(during.flatMap((h) => h.methods));
  for (const method of ["eth_call", "eth_estimateGas", "eth_sendRawTransaction", "eth_getTransactionReceipt"])
    expect([...methods], `wallet handled ${method}`).toContain(method);
  await indexed();
  await page.keyboard.press("Escape");
  // The header balance comes from the API and shows the mint.
  const config = await api<ApiConfig>("/config");
  const after = (await client.readContract({
    address: config.quote.address as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [actor(index).address],
  })) as bigint;
  expect(after - before).toBe(10_000n * 10n ** 6n);
  await page.getByTestId("wallet-button").click();
  await expect(page.getByTestId("wallet-balance")).toContainText(Number(after / 10n ** 6n).toLocaleString("en-US"));
  await page.screenshot({ path: "e2e/screenshots/no-rpc-local-wallet-menu.png", animations: "disabled" });
});

/**
 * A browser wallet on the testnet build (chain 1952). Its node traffic runs in the test process, outside the page,
 * exactly as an extension's does; the page only ever calls `window.okxwallet.request`.
 */
async function extensionWallet(page: Page, address: Address) {
  await page.exposeBinding("__walletNode", async (_source, request: { method: string; params?: unknown[] }) => {
    const { method } = request;
    let { params } = request;
    if (method === "eth_sendTransaction") {
      const tx = { ...(params![0] as Record<string, unknown>) };
      delete tx.chainId;
      params = [tx];
    }
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
    });
    return response.json();
  });
  await page.addInitScript(
    ({ address }) => {
      const listeners = new Map<string, Set<(value: unknown) => void>>();
      let connected = sessionStorage.getItem("fixture-connected") === "1";
      const calls: string[] = [];
      const node = (request: unknown) =>
        (
          window as unknown as { __walletNode: (r: unknown) => Promise<{ result?: unknown; error?: unknown }> }
        ).__walletNode(request);
      const provider = {
        on(event: string, listener: (value: unknown) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(listener);
        },
        removeListener(event: string, listener: (value: unknown) => void) {
          listeners.get(event)?.delete(listener);
        },
        async request(request: { method: string; params?: unknown[] }) {
          calls.push(request.method);
          switch (request.method) {
            case "eth_accounts":
              return connected ? [address] : [];
            case "eth_requestAccounts":
            case "wallet_requestPermissions":
              connected = true;
              sessionStorage.setItem("fixture-connected", "1");
              return request.method === "eth_requestAccounts" ? [address] : [{ parentCapability: "eth_accounts" }];
            case "wallet_getPermissions":
              return [];
            case "eth_chainId":
              return "0x7a0";
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":
              return null;
          }
          const value = await node(request);
          if (value.error) throw value.error;
          return value.result;
        },
      };
      Object.assign(window, { okxwallet: provider, walletCalls: calls });
    },
    { address },
  );
}

test("No RPC — testnet build: every route and a signed transaction make zero RPC requests from the page", async ({
  page,
  context,
}) => {
  test.setTimeout(15 * 60 * 1000);
  // The testnet build talks to the same local API; present it as X Layer testnet with the test quote token.
  await context.route(`${API_URL}/v2/config`, async (route) => {
    const config = await api<ApiConfig>("/config");
    await route.fulfill({
      json: { ...config, chainId: 1952, isLocal: false, quote: { ...config.quote, testToken: true } },
    });
  });

  // X Layer's keyless public RPC, played here by the local node the test runs on.
  for (const host of PUBLIC_RPC_HOSTS) {
    await context.route(`https://${host}/**`, async (route) => {
      const request = route.request();
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "POST, OPTIONS",
      };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: request.postData() ?? "",
      });
      await route.fulfill({
        status: res.status,
        headers: { ...cors, "content-type": "application/json" },
        body: await res.text(),
      });
    });
  }
  const recorder = recordRpc(context);
  // A fresh account (never used by the other specs), unlocked on the node so the stand-in wallet can send for it.
  const user = actor(16).address;
  await client.request({ method: "anvil_setBalance", params: [user, "0x56bc75e2d63100000"] } as never);
  await client.request({ method: "anvil_impersonateAccount", params: [user] } as never);
  await extensionWallet(page, user);
  const routes = (await everyRoute()).filter((r) => r !== "/dev");

  await visitAll(page, TESTNET_WEB_URL, routes, recorder);
  expect(describe(recorder.hits), "testnet, disconnected").toEqual([]);

  recorder.at(`${TESTNET_WEB_URL}/portfolio connect`);
  await page.goto(`${TESTNET_WEB_URL}/portfolio`);
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("wallet-option-okx").click();
  await expect(page.getByTestId("wallet-button")).toBeVisible();
  await visitAll(page, TESTNET_WEB_URL, routes, recorder);
  expect(describe(recorder.hits), "testnet, connected").toEqual([]);

  // The test USDG faucet: the checks go to the keyless public RPC, and the wallet only signs and sends.
  recorder.at(`${TESTNET_WEB_URL}/portfolio faucet`);
  await page.goto(`${TESTNET_WEB_URL}/portfolio`);
  await page.getByTestId("test-usdg-faucet").getByRole("button").click();
  await page.getByTestId("confirm-transaction").click();
  await expect(page.getByTestId("transaction-drawer")).toHaveAttribute("data-status", "confirmed", { timeout: 45_000 });
  expect(recorder.hits.length, "the transaction's checks reached the public RPC").toBeGreaterThan(0);
  for (const hit of recorder.hits) {
    const url = new URL(hit.url);
    expect(PUBLIC_RPC_HOSTS, `${hit.url} is a keyless public X Layer RPC`).toContain(url.host);
    expect(`${url.pathname}${url.search}`, `${hit.url} carries no key`).toMatch(/^\/(terigon)?$/);
    for (const method of hit.methods) expect(TX_METHODS, `${method} is a transaction-time call`).toContain(method);
  }
  const calls = await page.evaluate(() => (window as unknown as { walletCalls: string[] }).walletCalls);
  expect(calls, "wallet handled eth_sendTransaction").toContain("eth_sendTransaction");
  await page.keyboard.press("Escape");
  // The header balance is the API's indexed balance.
  await indexed();
  await page.getByTestId("wallet-button").click();
  await expect(page.getByTestId("wallet-balance")).toContainText("10,000");
  await page.screenshot({ path: "e2e/screenshots/no-rpc-testnet-wallet-menu.png", animations: "disabled" });
  await client.request({ method: "anvil_stopImpersonatingAccount", params: [user] } as never);
});
