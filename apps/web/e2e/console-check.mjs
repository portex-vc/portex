// Loads pages and prints browser console errors/warnings + failed requests.
// usage: node e2e/console-check.mjs http://localhost:3100 / /protocol /raise/0x…
import { chromium } from "@playwright/test";

const [base, ...paths] = process.argv.slice(2);
if (!base || paths.length === 0) {
  console.error("usage: node e2e/console-check.mjs <base> <path> [path…]");
  process.exit(2);
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let problems = 0;
for (const p of paths) {
  const issues = [];
  const onConsole = (m) => {
    if (m.type() === "error" || m.type() === "warning") issues.push(`[console.${m.type()}] ${m.text().slice(0, 400)}`);
  };
  const onError = (e) => issues.push(`[pageerror] ${String(e).slice(0, 400)}`);
  const onFail = (r) => {
    const error = r.failure()?.errorText ?? "";
    // Browser-canceled requests (Next.js <Link> RSC prefetches) are not application failures.
    if (error === "net::ERR_ABORTED") return;
    issues.push(`[request failed] ${r.url()} ${error}`);
  };
  page.on("console", onConsole);
  page.on("pageerror", onError);
  page.on("requestfailed", onFail);
  await page
    .goto(base + p, { waitUntil: "networkidle", timeout: 60_000 })
    .catch((e) => issues.push(`[goto] ${e.message}`));
  await page.waitForTimeout(2500);
  page.off("console", onConsole);
  page.off("pageerror", onError);
  page.off("requestfailed", onFail);
  console.log(`\n== ${p}: ${issues.length === 0 ? "clean" : issues.length + " issue(s)"}`);
  for (const i of issues) console.log("  " + i);
  problems += issues.length;
}
await browser.close();
process.exit(problems > 0 ? 1 : 0);
