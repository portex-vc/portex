import { test, expect } from "@playwright/test";
import { WEB_URL } from "./env";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import es from "../messages/es.json";

const SECTIONS = Object.keys(en.wiki.s);

test("W — the wiki renders every section in en/zh/es at 1280 and 390 with a clean console", async ({
  page,
  context,
}) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(String(error)));
  for (const [locale, messages] of Object.entries({ en, zh, es })) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: WEB_URL }]);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/wiki");
      await expect(page.locator("main h1")).toHaveText(messages.wiki.title);
      for (const id of SECTIONS) await expect(page.locator(`section h2#${id}`)).toHaveCount(1);
      await expect(page.getByTestId("wiki-faq").locator("dt")).toHaveCount(messages.wiki.s.faq.items.length);
      await expect(page.getByTestId("wiki-glossary").locator("dt")).toHaveCount(messages.wiki.s.glossary.items.length);
      await expect(page.getByTestId("wiki-stepper")).toBeVisible();
      // No sideways page scroll on phones.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width === 1280) {
        await page.getByTestId("wiki-nav").getByTestId("wiki-nav-exits").click();
        await expect(page).toHaveURL(/#exits$/);
        await expect(page.getByTestId("wiki-nav").getByTestId("wiki-nav-exits")).toHaveAttribute(
          "aria-current",
          "location",
        );
      } else {
        await page.getByTestId("wiki-contents").locator("summary").click();
        await page.getByTestId("wiki-contents").getByTestId("wiki-nav-treasury").click();
        await expect(page).toHaveURL(/#treasury$/);
        await expect(page.getByTestId("wiki-contents")).not.toHaveAttribute("open", "");
      }
    }
  }
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: WEB_URL }]);
  await page.goto("/");
  await page.getByTestId("footer-wiki").click();
  await expect(page).toHaveURL(/\/wiki$/);
  expect(problems).toEqual([]);
});
