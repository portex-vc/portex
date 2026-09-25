import { test, expect, type Page } from "@playwright/test";
import { actor, api, audit, client, confirm, connect, findRaise, indexed } from "./helpers";
import en from "../messages/en.json";

test.describe.configure({ mode: "serial" });

interface PoolTrade {
  side: "buy" | "sell";
  trader: string;
  viaRouter: boolean;
  amountQuote: string;
  amountToken: string;
  txHash: string;
}

/** Approve the input asset when the panel asks for it, then swap; both through the transaction drawer. */
async function swap(page: Page, symbol: string, verb: "buy" | "sell") {
  const button = page.getByTestId("swap-submit");
  await expect(button).toBeEnabled();
  if ((await button.textContent())?.includes("Approve")) {
    await button.click();
    await confirm(page);
    await expect(button).not.toContainText("Approve");
    await expect(button).toBeEnabled();
  }
  await expect(button).toContainText(en.markets.swap[verb].replace("{symbol}", symbol));
  await button.click();
  await expect(page.getByTestId("transaction-quote")).toContainText(en.markets.swap.minimumReceived);
  await confirm(page);
}

test("M — buy then sell in the Stage 3 pool; the tape and the chart record both", async ({ page }) => {
  // Leave the fixture chain exactly as seeded for the suites that follow.
  const snapshot = await client.request({ method: "evm_snapshot", params: [] } as never);
  try {
    const listed = await findRaise("ATLAS");
    await page.goto("/markets");
    const row = page.getByTestId("market-row").filter({ hasText: "ATLAS" });
    await expect(row).toBeVisible();
    await audit(page, "markets-list", true);
    await row.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/markets/${listed.address}$`, "i"));
    await expect(page.getByTestId("market-price")).toBeVisible();
    await expect(page.getByTestId("project-link")).toHaveAttribute("href", `/raise/${listed.address}`);
    const chart = page.getByTestId("candles");
    await expect(chart).toHaveAttribute("data-bars", /^[1-9]\d*$/);
    const tradesBefore = Number(await chart.getAttribute("data-trades"));
    const apiBefore = await api<PoolTrade[]>(`/raises/${listed.address}/pool-trades`);

    // The buyer account holds USDG and delivered ATLAS from Stage 2.
    await connect(page, 14);
    await expect(page.getByTestId("position-balance")).not.toHaveText("0");

    await page.getByTestId("swap-side-buy").click();
    await page.locator("#swap-amount").fill("250");
    await expect(page.getByTestId("swap-quote")).toContainText(en.markets.swap.receive);
    await expect(page.getByTestId("swap-quote")).toContainText(en.markets.swap.priceImpact);
    await audit(page, "market-buy-quote", true);
    await swap(page, "ATLAS", "buy");
    const tape = page.getByTestId("tape-row");
    await expect(tape.first()).toHaveAttribute("data-side", "buy");
    await expect(tape.first()).toContainText(en.markets.tape.you);
    await expect.poll(async () => Number(await chart.getAttribute("data-trades"))).toBe(tradesBefore + 1);

    await page.getByTestId("swap-side-sell").click();
    await page.locator("#swap-amount").fill("100");
    await expect(page.getByTestId("swap-quote")).toContainText(en.markets.swap.receive);
    await swap(page, "ATLAS", "sell");
    await expect(tape.first()).toHaveAttribute("data-side", "sell");
    await expect(tape.first()).toContainText(en.markets.tape.you);
    await expect(tape.nth(1)).toHaveAttribute("data-side", "buy");
    await expect.poll(async () => Number(await chart.getAttribute("data-trades"))).toBe(tradesBefore + 2);
    await audit(page, "market-after-trades", true);

    const trades = await api<PoolTrade[]>(`/raises/${listed.address}/pool-trades`);
    expect(trades.length).toBe(apiBefore.length + 2);
    const [sold, bought] = trades;
    expect(bought).toMatchObject({ side: "buy", trader: actor(14).address, viaRouter: true, amountQuote: "250" });
    expect(sold).toMatchObject({ side: "sell", trader: actor(14).address, viaRouter: true, amountToken: "100" });
    const market = await api<{ market: { tradeCount: number; volume24h: string } }>(`/markets/${listed.address}`);
    expect(market.market.tradeCount).toBe(apiBefore.length + 2);
    expect(Number(market.market.volume24h)).toBeGreaterThanOrEqual(250);
  } finally {
    await client.request({ method: "evm_revert", params: [snapshot] } as never);
    await client.request({ method: "evm_mine", params: [] } as never);
    await indexed();
  }
});

test("M — the markets list and trading page have designed empty and unavailable states", async ({ page }) => {
  const stage2 = await findRaise("SIGNAL");
  await page.goto(`/markets/${stage2.address}`);
  await expect(page.getByTestId("market-not-listed")).toBeVisible();
  await expect(page.getByRole("link", { name: en.markets.page.projectPage })).toHaveAttribute(
    "href",
    `/raise/${stage2.address}`,
  );
  await page.goto("/markets/0x0000000000000000000000000000000000000001");
  await expect(page.getByTestId("not-found")).toBeVisible();
});
