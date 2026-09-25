import { test, expect, type Page } from "@playwright/test";
import { actor, api, audit, client, confirm, connect, findRaise } from "./helpers";
import { WEB_URL } from "./env";
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
    // The pre-revert indexed block is above the new head, so `indexed()` would pass at once. Wait until the API has
    // rolled back to the reverted chain and re-indexed exactly its head, with every raise's state rebuilt.
    const head = Number(await client.getBlockNumber({ cacheTime: 0 }));
    await expect
      .poll(async () => (await api<{ indexedBlock: number }>("/health")).indexedBlock, { timeout: 60_000 })
      .toBe(head);
    await expect
      .poll(async () => (await api<{ symbol: string }[]>("/raises")).some((r) => r.symbol === "ATLAS"))
      .toBe(true);
  }
});

/**
 * Drags the candle timeline back and forth (and sweeps the crosshair) while the chart card's header is on screen,
 * sampling the scroll position and the card's height on every animation frame.
 */
async function dragSamples(page: Page) {
  await page.evaluate(() => {
    const card = document.querySelector('[data-testid="market-chart"]')!.closest("section")!;
    // Header partly visible: the card's top edge sits 120 px below the top of the viewport.
    window.scrollTo(0, window.scrollY + card.getBoundingClientRect().top - 120);
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const card = document.querySelector('[data-testid="market-chart"]')!.closest("section")!;
    const tape = document.querySelector('[data-testid="trades-tape"]');
    const w = window as unknown as { samples: number[][]; sampling: boolean };
    w.samples = [];
    w.sampling = true;
    const tick = () => {
      w.samples.push([
        window.scrollY,
        card.getBoundingClientRect().height,
        tape ? tape.getBoundingClientRect().top + window.scrollY : 0,
      ]);
      if (w.sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const box = (await page.getByTestId("candles").boundingBox())!;
  const y = box.y + box.height * 0.45;
  let x = box.x + box.width * 0.8;
  await page.mouse.move(x, y);
  for (let pass = 0; pass < 2; pass++) {
    await page.mouse.down();
    for (let i = 0; i < 30; i++) await page.mouse.move((x -= box.width * 0.015), y);
    for (let i = 0; i < 30; i++) await page.mouse.move((x += box.width * 0.015), y);
    await page.mouse.up();
    for (let i = 0; i < 20; i++) await page.mouse.move(box.x + box.width * (0.04 + i * 0.047), y);
  }
  const samples = await page.evaluate(() => {
    const w = window as unknown as { samples: number[][]; sampling: boolean };
    w.sampling = false;
    return w.samples;
  });
  const distinct = (i: number) => new Set(samples.map((s) => Math.round(s[i] * 100))).size;
  return { frames: samples.length, scrollY: distinct(0), cardHeight: distinct(1), tapeTop: distinct(2) };
}

test("M — dragging the chart never moves the page; the listing is a neutral line", async ({ page, context }) => {
  const listed = await findRaise("ATLAS");
  for (const locale of ["en", "zh"]) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: WEB_URL }]);
    // 1200 and 768 are where the legend used to wrap between one and two lines while it updated.
    for (const width of [1440, 1200, 768, 390]) {
      await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
      await page.goto(`/markets/${listed.address}`);
      const chart = page.getByTestId("candles");
      await expect(chart.locator("canvas").first()).toBeVisible();
      await expect(chart).toHaveAttribute("data-bars", /^[1-9]\d*$/);
      await expect(chart).toHaveAttribute("data-listing", /^\d+$/);
      await expect(page.getByTestId("listing-legend")).toBeVisible();
      const legend = page.getByTestId("chart-legend");
      // One line, never clipped: the fields fit the card at every width.
      expect(await legend.evaluate((el) => [el.clientHeight, el.scrollWidth <= el.clientWidth])).toEqual([20, true]);
      const result = await dragSamples(page);
      expect(result.frames, `${locale} ${width}`).toBeGreaterThan(30);
      expect(result, `${locale} ${width}`).toEqual({ frames: result.frames, scrollY: 1, cardHeight: 1, tapeTop: 1 });
    }
  }
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: WEB_URL }]);
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
