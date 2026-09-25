import { test, expect } from "@playwright/test";
import { api } from "./helpers";
import { WEB_URL } from "./env";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import es from "../messages/es.json";
import type { ApiConfig } from "../src/lib/api";

const SECTIONS = [...Object.keys(en.docs.s), "stage1", "stage2", "stage3"].filter((v, i, a) => a.indexOf(v) === i);

test("Docs — every section in en/zh/es at 1280 and 390, clean console, working nav", async ({ page, context }) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(String(error)));
  for (const [locale, messages] of Object.entries({ en, zh, es })) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: WEB_URL }]);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/docs");
      await expect(page.locator("main h1")).toHaveText(messages.docs.heading);
      for (const id of SECTIONS) await expect(page.locator(`section h2#${id}`)).toHaveCount(1);
      await expect(page.getByTestId("docs-faq").locator("dt")).toHaveCount(messages.docs.s.faq.items.length);
      await expect(page.getByTestId("docs-glossary").locator("dt")).toHaveCount(messages.docs.s.glossary.items.length);
      await expect(page.getByTestId("docs-steps").first()).toBeVisible();
      expect(await page.locator("body").innerText()).not.toMatch(/\bwiki\b|百科/i);
      // No sideways page scroll on phones.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width === 1280) {
        await page.getByTestId("docs-nav").getByTestId("docs-nav-exits").click();
        await expect(page).toHaveURL(/#exits$/);
        await expect(page.getByTestId("docs-nav").getByTestId("docs-nav-exits")).toHaveAttribute(
          "aria-current",
          "location",
        );
      } else {
        await page.getByTestId("docs-contents").locator("summary").click();
        await page.getByTestId("docs-contents").getByTestId("docs-nav-guideBacker").click();
        await expect(page).toHaveURL(/#guideBacker$/);
        await expect(page.getByTestId("docs-contents")).not.toHaveAttribute("open", "");
      }
    }
  }
  expect(problems).toEqual([]);
});

test("Docs — deployed contracts come from the deployment, and timings from the current version", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: WEB_URL }]);
  const config = await api<ApiConfig>("/config");
  await page.goto("/docs#contracts");
  const contracts = page.getByTestId("docs-contracts");
  for (const address of [
    config.addresses.registry,
    config.addresses.factory,
    config.addresses.router!,
    config.quote.address,
  ])
    await expect(contracts).toContainText(address);
  await expect(contracts).toContainText(config.templates[0].implementations.raise);
  await expect(contracts).toContainText(config.templates[0].bundleHash);
  await expect(page.getByTestId("docs-network")).toContainText("1952");
  // The local fixture pins production timings: the current column repeats them and nothing is marked shortened.
  await expect(page.getByTestId("timing-current-stage1")).toContainText("15–60 days");
  await expect(page.locator("[data-testid^=live-timing-]")).toHaveCount(0);
});

test("Docs — reachable from the header, mobile menu, command palette and footer; /wiki redirects", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: WEB_URL }]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.locator('header [data-nav="/docs"]').click();
  await expect(page).toHaveURL(/\/docs$/);
  await expect(page.locator('header [data-nav="/docs"]')).toHaveAttribute("aria-current", "page");
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByTestId("command-palette").getByRole("option", { name: en.nav.docs }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await page.goto("/");
  await page.getByTestId("footer-docs").click();
  await expect(page).toHaveURL(/\/docs$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByTestId("mobile-menu").click();
  await page.getByRole("dialog").getByRole("link", { name: en.nav.docs }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await page.goto("/wiki#treasury");
  await expect(page).toHaveURL(/\/docs#treasury$/);
  await expect(page.locator("main h1")).toHaveText(en.docs.heading);
});
