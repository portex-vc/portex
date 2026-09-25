import { expect, test, type Page } from "@playwright/test";
import { API_URL, RPC_URL, TESTNET_WEB_URL } from "./env";
import { actor, api, client, findRaise } from "./helpers";
import type { ApiConfig } from "../src/lib/api";
import { erc20Abi } from "../src/lib/contracts";
import type { Address } from "viem";

// Every RPC request is intercepted and served by the isolated fixture. No public-chain writes.
async function walletFixture(page: Page, rejectSwitch = false) {
  await page.route("https://testrpc.xlayer.tech/**", async (route) => {
    const response = await route.fetch({ url: RPC_URL });
    await route.fulfill({ response });
  });
  await page.route(`${API_URL}/v2/config`, async (route) => {
    const config = await api<ApiConfig>("/config");
    // Testnet pins short stage timings into each template version (and older APIs expose them as stageBounds).
    const hours = { stage1Min: 3600, stage1Max: 172800, stage2Min: 7200, stage2Max: 259200 };
    await route.fulfill({
      json: {
        ...config,
        chainId: 1952,
        isLocal: false,
        quote: { ...config.quote, symbol: "TEST USDG", testToken: true },
        stageBounds: hours,
        templates: config.templates.map((t) => ({ ...t, parameters: { ...t.parameters, ...hours } })),
      },
    });
  });
  await page.addInitScript(
    ({ address, rpc, reject }) => {
      const listeners = new Map<string, Set<(value: unknown) => void>>();
      let chain = sessionStorage.getItem("fixture-chain") ?? "0x1";
      let known = chain === "0x7a0";
      let connected = sessionStorage.getItem("fixture-connected") === "1";
      let rejection = reject;
      const calls: { method: string; params?: unknown[] }[] = [];
      const provider = {
        on(event: string, listener: (value: unknown) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(listener);
        },
        removeListener(event: string, listener: (value: unknown) => void) {
          listeners.get(event)?.delete(listener);
        },
        async request(request: { method: string; params?: unknown[] }) {
          calls.push(request);
          if (request.method === "eth_accounts") return connected ? [address] : [];
          if (request.method === "eth_requestAccounts") {
            connected = true;
            sessionStorage.setItem("fixture-connected", "1");
            return [address];
          }
          if (request.method === "eth_chainId") return chain;
          if (request.method === "wallet_requestPermissions") {
            connected = true;
            sessionStorage.setItem("fixture-connected", "1");
            return [{ parentCapability: "eth_accounts" }];
          }
          if (request.method === "wallet_getPermissions") return [];
          if (request.method === "wallet_switchEthereumChain") {
            if (rejection) {
              rejection = false;
              throw { code: 4001, message: "User rejected request" };
            }
            if (!known) throw { code: 4902, message: "Unknown chain" };
            chain = "0x7a0";
            sessionStorage.setItem("fixture-chain", chain);
            for (const listener of listeners.get("chainChanged") ?? []) listener(chain);
            return null;
          }
          if (request.method === "wallet_addEthereumChain") {
            known = true;
            chain = "0x7a0";
            sessionStorage.setItem("fixture-chain", chain);
            for (const listener of listeners.get("chainChanged") ?? []) listener(chain);
            return null;
          }
          if (request.method === "eth_sendTransaction") {
            const tx = { ...(request.params![0] as Record<string, unknown>) };
            delete tx.chainId;
            request = { ...request, params: [tx] };
          }
          const response = await fetch(rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...request }),
          });
          const value = await response.json();
          if (value.error) throw value.error;
          return value.result;
        },
      };
      Object.assign(window, { okxwallet: provider, walletCalls: calls });
    },
    { address: actor(0).address, rpc: RPC_URL, reject: rejectSwitch },
  );
}

test("testnet default UI auto-switches, adds missing chain and mints test USDG on the isolated fixture", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(String(error)));
  await walletFixture(page);
  await page.goto(`${TESTNET_WEB_URL}/portfolio`);
  await expect(page.getByTestId("network-indicator")).toHaveText("X Layer testnet");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-local-link")).toHaveCount(0);
  await page.getByTestId("wallet-option-okx").click();
  await expect(page.getByTestId("wallet-button")).toBeVisible();
  await expect(page.getByTestId("test-usdg-faucet")).toBeVisible();
  await expect(page.getByTestId("test-usdg-faucet").getByRole("button")).toBeEnabled();
  const calls = await page.evaluate(
    () => (window as unknown as { walletCalls: { method: string; params: unknown[] }[] }).walletCalls,
  );
  expect(calls.some((call) => call.method === "wallet_switchEthereumChain")).toBe(true);
  expect(calls.find((call) => call.method === "wallet_addEthereumChain")?.params[0]).toMatchObject({
    chainId: "0x7a0",
    chainName: "X Layer testnet",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: ["https://testrpc.xlayer.tech/terigon"],
    blockExplorerUrls: ["https://www.oklink.com/xlayer-test"],
  });
  expect(await page.locator("body").innerText()).not.toMatch(/Local chain|31337/);
  const fresh = await findRaise("HARBOR");
  await page.goto(`${TESTNET_WEB_URL}/raise/${fresh.address}`);
  await expect(page.getByTestId("test-usdg-faucet")).toBeVisible();
  await page.getByTestId("test-usdg-faucet").getByRole("button").click();
  await expect(page.getByTestId("transaction-drawer")).toContainText("TEST USDG");
  await page.getByTestId("confirm-transaction").click();
  await expect(page.getByTestId("transaction-drawer")).toHaveAttribute("data-status", "confirmed", { timeout: 45000 });
  expect(
    await client.readContract({
      address: fresh.quote.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [actor(0).address],
    }),
  ).toBe(10_000_000_000n);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("test-usdg-faucet")).toHaveCount(0);
  await page.goto(`${TESTNET_WEB_URL}/create`);
  await page.getByTestId("create-step-schedule").click();
  await expect(page.getByLabel("Stage 1 length (hours)")).toHaveValue("24");
  await expect(page.getByLabel("Stage 2 length (hours)")).toHaveValue("48");
  await expect(page.getByTestId("stage-bounds")).toContainText("Allowed stage lengths");
  expect(problems).toEqual([]);
  const response = await page.goto(`${TESTNET_WEB_URL}/dev`);
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId("dev-mint")).toHaveCount(0);
});

test("rejected automatic switch leaves the network pill as a working fallback", async ({ page }) => {
  await walletFixture(page, true);
  await page.goto(`${TESTNET_WEB_URL}/portfolio`);
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("wallet-option-okx").click();
  await expect(page.getByTestId("network-wrong")).toBeVisible();
  await page.getByTestId("network-wrong").click();
  await expect(page.getByTestId("network-indicator")).toHaveText("X Layer testnet");
  await expect(page.getByTestId("test-usdg-faucet").getByRole("button")).toBeEnabled();
});
