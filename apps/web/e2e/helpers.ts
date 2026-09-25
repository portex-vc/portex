import { expect, type Page } from "@playwright/test";
import { createPublicClient, createWalletClient, http, decodeEventLog, parseUnits, type Abi, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { API_URL, RPC_URL } from "./env";
import { raiseAbi, raiseFactoryAbi, erc20Abi } from "../src/lib/contracts";
import type { ApiConfig, RaiseDetail, RaiseSummary, Position } from "../src/lib/api";
export const client = createPublicClient({ chain: foundry, transport: http(RPC_URL), pollingInterval: 100 });
export const actor = (index: number) =>
  mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: index });
export const usd = (amount: string | number) => parseUnits(String(amount), 6);
export async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}/v2${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
export const detail = (address: string) => api<RaiseDetail>(`/raises/${address}`);
export const positions = (raise: string, index: number) =>
  api<Position>(`/raises/${raise}/positions/${actor(index).address}`);
export async function indexed() {
  const block = await client.getBlockNumber({ cacheTime: 0 });
  await expect
    .poll(async () => BigInt((await api<{ indexedBlock: number }>("/health")).indexedBlock))
    .toBeGreaterThanOrEqual(block);
}
export async function write(index: number, address: string, abi: Abi, functionName: string, args: unknown[] = []) {
  const account = actor(index),
    wallet = createWalletClient({ chain: foundry, account, transport: http(RPC_URL), pollingInterval: 100 });
  const { request } = await client.simulateContract({ address: address as Address, abi, functionName, args, account });
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  await indexed();
  return receipt;
}
export async function warpTo(timestamp: number) {
  const now = Number((await client.getBlock()).timestamp);
  if (timestamp > now) {
    await client.request({ method: "evm_increaseTime", params: [timestamp - now] } as never);
    await client.request({ method: "evm_mine", params: [] } as never);
  }
  await indexed();
}
export async function findRaise(symbol: string) {
  const raises = await api<RaiseSummary[]>("/raises");
  const r = raises.find((r) => r.symbol === symbol);
  if (!r) throw new Error(`Missing ${symbol}`);
  return detail(r.address);
}
export async function createFixture(name: string, budget = false, stage1Days = 15) {
  const cfg = await api<ApiConfig>("/config");
  const template = cfg.templates.find((t) => t.name === (budget ? "BUDGET_LAUNCH" : "ESCROW_LAUNCH"))!;
  const receipt = await write(3, cfg.addresses.factory, raiseFactoryAbi, "createRaise", [
    template.id,
    BigInt(template.version),
    {
      quote: cfg.quote.address,
      treasury: "0x0000000000000000000000000000000000000000",
      supply: parseUnits("1000000", 18),
      targetPrice: parseUnits("0.1", 18),
      budgetCeiling: budget ? parseUnits("0.3", 18) : 0n,
      stage1Length: BigInt(stage1Days) * 86400n,
      stage2Length: 70n * 86400n,
      builders: [],
    },
    { name, symbol: name.replaceAll(" ", "").slice(0, 8).toUpperCase() },
  ]);
  for (const log of receipt.logs) {
    try {
      const e = decodeEventLog({ abi: raiseFactoryAbi, topics: log.topics, data: log.data });
      if (e.eventName === "RaiseCreated") return detail((e.args as unknown as { raise: string }).raise);
    } catch {
      /* Other logs. */
    }
  }
  throw new Error("Missing creation event");
}
export async function fund(index: number) {
  const cfg = await api<ApiConfig>("/config");
  await client.request({ method: "anvil_setBalance", params: [actor(index).address, "0x56bc75e2d63100000"] } as never);
  await write(0, cfg.quote.address, erc20Abi, "mint", [actor(index).address, usd(1000000)]);
}
export async function guarded(index: number, r: RaiseDetail, fn: string, args: unknown[]) {
  const nonce = (await client.readContract({
    address: r.address as Address,
    abi: raiseAbi,
    functionName: "stateNonce",
  })) as bigint;
  return write(index, r.address, raiseAbi, fn, [...args, nonce, (await client.getBlock()).timestamp + 600n]);
}
export async function fixtureDeposit(index: number, r: RaiseDetail, amount: bigint) {
  await write(index, r.quote.address, erc20Abi, "approve", [r.address, amount]);
  return guarded(index, r, "deposit", [amount, 0n]);
}
export async function fillAndOpen(r: RaiseDetail) {
  for (let i = 4; i < 14; i++) await fixtureDeposit(i, r, usd(1000));
  await fixtureDeposit(4, r, usd(100000));
  await warpTo(r.deadlines.stage1End);
  await write(0, r.address, raiseAbi, "advanceStage1");
  return detail(r.address);
}
const LOCAL_NAMES: Record<number, string> = {
  0: "Deployer",
  1: "Attester",
  2: "Council",
  3: "Builder",
  14: "Buyer",
  15: "Whale",
};
/** Display name of local test account `index` in the English UI. */
export const localName = (index: number) => LOCAL_NAMES[index] ?? `Backer ${index - 3}`;
/**
 * Act as local test account `index`: choose it in the Dev page's "Local test accounts" panel, confirm
 * the header wallet shows its name, then return to the page the test was on.
 */
export async function connectAs(page: Page, index: number) {
  const back = page.url() === "about:blank" ? "/" : page.url();
  await page.goto("/dev#local-accounts");
  const row = page.getByTestId(`local-account-${index}`);
  await expect(row).toBeVisible();
  const use = page.getByTestId(`account-${index}`);
  if (await use.isVisible()) await use.click();
  await expect(row).toContainText("In use");
  await expect(page.getByTestId("wallet-button")).toContainText(localName(index));
  if (!back.includes("/dev")) {
    await page.goto(back);
    await expect(page.getByTestId("wallet-button")).toContainText(localName(index));
  }
}
/** @deprecated Use connectAs. */
export const connect = connectAs;
/**
 * Audit evidence: capture the current screen in dark/light at 1440/390 as
 * e2e/screenshots/audit-<name>-<theme>-<width>.png without reloading, so transient states
 * (open drawers, pending phases) survive. Disabled with PORTEX_AUDIT=0.
 */
export async function audit(page: Page, name: string, fullPage = false) {
  if (process.env.PORTEX_AUDIT === "0") return;
  const original = page.viewportSize();
  const initial = await page.evaluate(() => (document.documentElement.classList.contains("light") ? "light" : "dark"));
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t) => {
      const root = document.documentElement;
      root.classList.remove("dark", "light");
      root.classList.add(t);
      root.style.colorScheme = t;
    }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
      await page.waitForTimeout(250);
      if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `e2e/screenshots/audit-${name}-${theme}-${width}.png`,
        fullPage,
        animations: "disabled",
      });
    }
  }
  await page.evaluate((t) => {
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    root.classList.add(t);
    root.style.colorScheme = t;
  }, initial);
  if (original) await page.setViewportSize(original);
}
/**
 * Hold browser JSON-RPC calls of the given methods for `ms` (to photograph the drawer's signing and
 * pending phases). Returns a release function.
 */
export async function holdRpc(page: Page, methods: string[], ms: number) {
  const handler = async (route: import("@playwright/test").Route) => {
    const body = route.request().postDataJSON() as { method?: string } | { method?: string }[] | null;
    const list = Array.isArray(body) ? body : body ? [body] : [];
    if (list.some((call) => call.method && methods.includes(call.method)))
      await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => {});
  };
  await page.route(RPC_URL, handler);
  return () => page.unroute(RPC_URL, handler);
}
export async function confirm(page: Page, evidence: { review?: string; done?: string } = {}) {
  const drawer = page.getByTestId("transaction-drawer");
  await expect(page.getByTestId("confirm-transaction")).toBeVisible();
  if (evidence.review) await audit(page, evidence.review);
  await page.getByTestId("confirm-transaction").click();
  await expect(drawer.getByText("Confirmed on-chain.", { exact: true })).toBeVisible({ timeout: 45000 });
  await expect(drawer.getByTestId("transaction-hash")).toHaveText(/^0x[\da-f]{64}$/i);
  if (evidence.done) await audit(page, evidence.done);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await indexed();
}
export async function money(page: Page, action: string, amount: string) {
  await page.getByTestId(`action-${action}`).click();
  await page.locator("#action-amount").fill(amount);
  const button = page.getByTestId("submit-action");
  await expect(button).toBeEnabled();
  const approving = (await button.textContent())?.includes("Approve");
  await button.click();
  await confirm(page);
  if (approving) {
    await expect(button).not.toContainText("Approve");
    await expect(button).toBeEnabled();
    await button.click();
    await confirm(page);
  }
}
