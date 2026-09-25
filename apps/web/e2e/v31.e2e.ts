import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { formatUnits, parseUnits, type Abi, type Address } from "viem";
import { WEB_URL, TMP_DIR } from "./env";
import venueAbi from "../src/generated/abi/UniswapV4Adapter.json";
import {
  api,
  actor,
  audit,
  holdRpc,
  client,
  confirm,
  connect,
  createFixture,
  detail,
  findRaise,
  fixtureDeposit,
  guarded,
  indexed,
  localNode,
  money,
  positions,
  usd,
  warpTo,
  write,
} from "./helpers";
import { tokenAbi } from "../src/lib/contracts";
import type { RaiseDetail, Proposal } from "../src/lib/api";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import es from "../messages/es.json";
let budget: RaiseDetail;
/** The local venue is the real v4 PoolManager: a venue outage is its code swapped for a bare revert, storage kept. */
const managerCode = new Map<string, string>();
async function venueFault(adapter: string, fail: boolean) {
  const manager = (await client.readContract({
    address: adapter as Address,
    abi: venueAbi as Abi,
    functionName: "poolManager",
  })) as Address;
  if (!managerCode.has(manager)) managerCode.set(manager, (await client.getCode({ address: manager }))!);
  const code = fail ? "0x60006000fd" : managerCode.get(manager)!;
  await client.request({ method: "anvil_setCode", params: [manager, code] } as never);
}
test.describe.configure({ mode: "serial" });

test("A — backer deposits twice, selects a position, exits partly and at cost in Stage 1", async ({ page }) => {
  const watch = await findRaise("WATCH");
  await page.goto(`/raise/${watch.address}`);
  await expect(page.locator("main h1")).toBeVisible();
  await audit(page, "raise-stage1-veto", true);
  const r = await findRaise("HARBOR");
  await page.goto(`/raise/${r.address}`);
  await expect(page.locator("main h1")).toBeVisible();
  await audit(page, "raise-stage1-disconnected", true);
  await connect(page, 4);
  const start = await positions(r.address, 4);
  if (!start.positions.length) await audit(page, "raise-stage1-backernoposition", true);
  // First deposit: approval, then deposit review and confirmation, photographed.
  await page.getByTestId("action-deposit").click();
  await page.locator("#action-amount").fill("100");
  await expect(page.getByTestId("quote-preview")).toContainText("Tokens received");
  await audit(page, "raise-stage1-depositquote", true);
  const submit = page.getByTestId("submit-action");
  if ((await submit.textContent())?.includes("Approve")) {
    await submit.click();
    await confirm(page, { review: "drawer-approvereview" });
    await expect(submit).not.toContainText("Approve");
  }
  await submit.click();
  await confirm(page, { review: "drawer-review", done: "drawer-confirmed" });
  // Second deposit: hold the wallet send and the receipt to photograph signing and pending.
  await page.locator("#action-amount").fill("50");
  await expect(submit).toBeEnabled();
  if ((await submit.textContent())?.includes("Approve")) {
    await submit.click();
    await confirm(page);
  }
  await submit.click();
  await expect(page.getByTestId("confirm-transaction")).toBeVisible();
  const release = await holdRpc(page, ["eth_sendRawTransaction", "eth_getTransactionReceipt"], 9000);
  await page.getByTestId("confirm-transaction").click();
  await expect(page.getByTestId("transaction-drawer")).toHaveAttribute("data-status", "signing");
  await audit(page, "drawer-signing");
  await expect(page.getByTestId("transaction-drawer")).toHaveAttribute("data-status", "pending", { timeout: 20000 });
  await audit(page, "drawer-pending");
  await release();
  await expect(page.getByTestId("transaction-drawer").getByText("Confirmed on-chain.", { exact: true })).toBeVisible({
    timeout: 45000,
  });
  await page.keyboard.press("Escape");
  await indexed();
  await audit(page, "raise-stage1-backerposition", true);
  const p = await positions(r.address, 4);
  expect(p.positions.length).toBe(start.positions.length + 2);
  const last = p.positions.at(-1)!;
  await page.getByTestId("action-exitAtCost").click();
  await page.getByTestId("position-picker").selectOption(last.id);
  const q = BigInt(last.positionState.tokens) / 2n;
  const expected = (BigInt(last.positionState.basis) * q) / BigInt(last.positionState.tokens);
  await page.locator("#action-amount").fill(formatUnits(q, 18));
  await expect(page.getByTestId("quote-preview")).toContainText("Quote reference");
  await audit(page, "raise-stage1-costexitquote", true);
  const before = BigInt((await positions(r.address, 4)).walletQuoteBalance);
  await page.getByTestId("submit-action").click();
  await confirm(page, { review: "drawer-costexitreview" });
  expect(BigInt((await positions(r.address, 4)).walletQuoteBalance) - before).toBe(expected);
  await page.getByTestId("quantity-all").click();
  await expect(page.getByTestId("submit-action")).toBeEnabled();
  await page.getByTestId("submit-action").click();
  await confirm(page);
  expect((await positions(r.address, 4)).positions.find((x) => x.id === last.id)!.positionState.tokens).toBe("0");
});

test("B — dissolved seed returns the exact position cost through ClaimVault", async ({ page }) => {
  const r = await findRaise("PILOT");
  const p = await positions(r.address, 4);
  const claim = p.positions.find((x) => BigInt(x.guaranteedClaim.amount) > 0n)!;
  await page.goto(`/raise/${r.address}`);
  await connect(page, 4);
  await expect(page.getByTestId("dissolved-card")).toBeVisible();
  await expect(page.getByTestId("dissolution-note")).toContainText("Stage 1 closed on");
  await expect(page.getByTestId("rollover-out")).toBeVisible();
  await audit(page, "raise-dissolved-claimbefore", true);
  await page.getByTestId(`refund-${claim.id}`).click();
  await confirm(page, { review: "drawer-refundreview" });
  const after = await positions(r.address, 4);
  expect(BigInt(after.walletQuoteBalance) - BigInt(p.walletQuoteBalance)).toBe(BigInt(claim.guaranteedClaim.amount));
  expect(after.positions.find((x) => x.id === claim.id)!.guaranteedClaim.amount).toBe("0");
});

test("C — outside buyer buys and sells; backer receives cost plus protected profit", async ({ page }) => {
  const r = await findRaise("SIGNAL");
  expect(r.phase).toBe("Stage2");
  await page.goto(`/raise/${r.address}`);
  await connect(page, 14);
  const before = await positions(r.address, 14);
  await page.getByTestId("action-buy").click();
  await page.locator("#action-amount").fill("1000");
  await expect(page.getByTestId("quote-preview")).toContainText("Price impact");
  await audit(page, "raise-stage2escrow-buyquote", true);
  await page.locator("#action-amount").fill("");
  await money(page, "buy", "1000");
  const bought = await positions(r.address, 14);
  expect(BigInt(bought.buyerLedger.tokens)).toBeGreaterThan(BigInt(before.buyerLedger.tokens));
  await money(page, "sell", "100");
  expect(BigInt((await positions(r.address, 14)).walletQuoteBalance)).toBeGreaterThan(
    BigInt(bought.walletQuoteBalance),
  );
  await connect(page, 4);
  const p = await positions(r.address, 4);
  const position = p.positions.find((x) => x.positionState.class === "Backer" && BigInt(x.positionState.tokens) > 0n)!;
  const quantity = parseUnits("100", 18);
  const cost = (BigInt(position.positionState.basis) * quantity) / BigInt(position.positionState.tokens);
  await page.getByTestId("action-protectedExit").click();
  await page.getByTestId("position-picker").selectOption(position.id);
  await page.locator("#action-amount").fill("100");
  await expect(page.getByTestId("quote-preview")).toContainText("Profit");
  await audit(page, "raise-stage2escrow-protectedexitquote", true);
  await page.getByTestId("submit-action").click();
  await confirm(page, { review: "drawer-protectedexitreview" });
  expect(BigInt((await positions(r.address, 4)).walletQuoteBalance) - BigInt(p.walletQuoteBalance)).toBeGreaterThan(
    cost,
  );
  await expect(page.getByTestId("cost-line")).toBeVisible();
});

test("D — Budget proposal, position votes, finalize, execute and proportional haircut", async ({ page }) => {
  budget = await createFixture("Budget Review", true);
  // Fill the ten-owner gate, then exercise the permissionless phase transition in the UI.
  for (let i = 4; i < 14; i++) {
    await write(i, budget.quote.address, (await import("../src/lib/contracts")).erc20Abi, "approve", [
      budget.address,
      usd(1000),
    ]);
    await guarded(i, budget, "deposit", [usd(1000), 0n]);
  }
  await write(4, budget.quote.address, (await import("../src/lib/contracts")).erc20Abi, "approve", [
    budget.address,
    usd(100000),
  ]);
  await guarded(4, budget, "deposit", [usd(100000), 0n]);
  await warpTo(budget.deadlines.stage1End);
  await page.goto(`/raise/${budget.address}`);
  await connect(page, 3);
  await expect(page.getByTestId("close-stage1")).toBeEnabled();
  await audit(page, "raise-stage1-deadlinepassed", true);
  await page.getByTestId("close-stage1").click();
  await confirm(page, { review: "drawer-closestage1review" });
  await expect.poll(async () => (await detail(budget.address)).phase).toBe("Stage2");
  budget = await detail(budget.address);
  await page.goto(`/raise/${budget.address}?tab=governance`);
  await expect(page.getByTestId("no-proposals")).toBeVisible();
  await audit(page, "raise-stage2budget-governancenoproposal", true);
  await page.locator("#proposal-amount").fill("500");
  await page.locator("#proposal-uri").fill("https://example.org/budget/review");
  await page.getByTestId("propose").click();
  await confirm(page, { review: "drawer-proposereview" });
  await connect(page, 4);
  await expect(page.getByTestId("vote-controls")).toBeVisible();
  await audit(page, "raise-stage2budget-governanceactive", true);
  const before = await positions(budget.address, 4);
  const proposal = page.getByTestId("proposal-1");
  for (const position of before.positions.filter(
    (x) => x.positionState.class === "Backer" && BigInt(x.positionState.basis) > 0n,
  )) {
    await proposal.getByRole("combobox").selectOption(position.id);
    await expect(proposal.getByTestId("vote-yes")).toBeEnabled();
    await proposal.getByTestId("vote-yes").click();
    await confirm(page);
  }
  const [p] = await api<Proposal[]>(`/raises/${budget.address}/proposals`);
  expect(BigInt(p.cap)).toBeGreaterThanOrEqual(usd(500));
  await warpTo(Number(p.votingEnds));
  await page.reload();
  await expect(page.getByTestId("finalize")).toBeVisible();
  await audit(page, "raise-stage2budget-governanceawaitingfinalization", true);
  await page.getByTestId("finalize").click();
  await confirm(page);
  await page.reload();
  await expect(page.getByTestId("proposal-1")).toBeVisible();
  await audit(page, "raise-stage2budget-governancepassed", true);
  await warpTo(Number(p.disputeEnds));
  await page.reload();
  await expect(page.getByTestId(`claim-bounds-${before.positions[0].id}`)).toBeVisible();
  await page.getByTestId("execute").click();
  await confirm(page, { review: "drawer-executereview" });
  const after = await positions(budget.address, 4);
  for (const record of before.positions) {
    expect(BigInt(after.positions.find((x) => x.id === record.id)!.guaranteedClaim.amount)).toBeLessThan(
      BigInt(record.guaranteedClaim.amount),
    );
  }
  await expect(page.getByTestId("proposal-1")).toContainText("Executed");
  await expect(page.getByTestId(`claim-bounds-${before.positions[0].id}`)).toContainText("Conditional range");
  await audit(page, "raise-stage2budget-governanceexecuted", true);
});

/** A 1×1 PNG for the project image upload. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function fillWizard(page: Page, withImage = false) {
  await page.getByTestId("create-next").click();
  await page.locator("#create-name").fill("Frontier Lab");
  await page.locator("#create-symbol").fill("FRONT");
  await page.locator("#create-description").fill("A launch created through the v3.1 frontend.");
  if (withImage) {
    // The Basics step uploads the project image before launch; it is saved with the description afterwards.
    await page
      .getByTestId("project-image-input")
      .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByTestId("project-image").locator("img")).toBeVisible({ timeout: 20_000 });
  }
  await page.getByTestId("create-next").click();
  await page.getByTestId("create-next").click();
  await page.getByTestId("create-next").click();
  await expect(page.getByTestId("treasury-note")).toBeVisible();
  await page.getByTestId("create-next").click();
}

test("Visual evidence — approved surfaces in dark/light at 1440/390", async ({ page }) => {
  const stage2 = await findRaise("SIGNAL"),
    listed = await findRaise("ATLAS");
  for (const theme of ["dark", "light"]) {
    await page.addInitScript((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await connect(page, 4);
      const routes: [[string, string], ...Array<[string, string]>] = [
        ["home", "/"],
        ["raise-stage2", `/raise/${stage2.address}?tab=market`],
        ["raise-budget", `/raise/${budget.address}?tab=governance`],
        ["raise-listed", `/raise/${listed.address}?tab=market`],
        ["portfolio", "/portfolio"],
        ["create-step1", "/create"],
      ];
      for (const [name, path] of routes) {
        await page.goto(path);
        await expect(page.locator("main h1")).toBeVisible();
        await page.waitForLoadState("networkidle");
        if (name === "raise-stage2") await expect(page.getByTestId("cost-line")).toBeVisible();
        if (name === "portfolio") {
          await page.locator("main details summary:visible").first().click();
          await expect(page.getByTestId("position-ledger").filter({ visible: true }).first()).toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(200);
        await page.screenshot({
          path: `e2e/screenshots/v31-${name}-${theme}-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
      await fillWizard(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      await page.screenshot({
        path: `e2e/screenshots/v31-create-review-${theme}-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
  }
});

test("E — listing pending keeps sells/cost exits, lists permissionlessly, then claims rewards", async ({ page }) => {
  let r = await findRaise("SIGNAL");
  await warpTo(r.deadlines.stage2End);
  r = await detail(r.address);
  expect(r.phase).toBe("ListingPending");
  await page.goto(`/raise/${r.address}`);
  await connect(page, 14);
  await expect(page.getByTestId("lifecycle-node-Stage2")).toHaveAttribute("data-state", "current");
  await expect(page.getByTestId("action-buy")).toHaveCount(0);
  await audit(page, "raise-listingpending-buyer", true);
  await money(page, "sell", "10");
  await connect(page, 4);
  await expect(page.getByTestId("action-protectedExit")).toHaveCount(0);
  await money(page, "exitAtCost", "10");
  await expect(page.getByTestId("list-action")).toBeEnabled();
  await audit(page, "raise-listingpending-backer", true);
  // Reproduce a venue failure after simulation but before the signed transaction is mined.
  let faultArmed = true;
  await page.route(localNode, async (route) => {
    const body = route.request().postDataJSON() as { method?: string };
    if (faultArmed && body.method === "eth_sendRawTransaction") {
      faultArmed = false;
      await venueFault(r.modules.adapter, true);
    }
    await route.continue();
  });
  await page.getByTestId("list-action").click();
  await page.getByTestId("confirm-transaction").click();
  await expect(page.getByTestId("transaction-drawer").getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("transaction-drawer")).toHaveAttribute("data-status", "reverted");
  await audit(page, "drawer-reverted");
  expect((await detail(r.address)).phase).toBe("ListingPending");
  const failed = await page.evaluate(() => JSON.parse(localStorage.getItem("portex.ListingAttemptFailed") ?? "[]"));
  expect(failed).toHaveLength(1);
  expect(failed[0].hash).toMatch(/^0x[\da-f]{64}$/i);
  expect(failed[0].revertData.length).toBeGreaterThan(0);
  await page.unroute(localNode);
  await venueFault(r.modules.adapter, false);
  await page.keyboard.press("Escape");
  await page.getByTestId("list-action").click();
  await expect(page.getByTestId("transaction-quote")).toContainText("Listing price");
  await confirm(page, { review: "drawer-listingreview" });
  await expect.poll(async () => (await detail(r.address)).phase).toBe("Stage3");
  r = await detail(r.address);
  await warpTo(r.deadlines.listedAt + 86400);
  await page.reload();
  await expect(page.getByTestId("claim-rewards")).toBeEnabled();
  await audit(page, "raise-stage3-afterlisting", true);
  const before = await positions(r.address, 4);
  expect(BigInt(before.walletTokenBalance)).toBeGreaterThan(0n);
  expect(BigInt(before.quota)).toBeGreaterThan(0n);
  await page.getByTestId("claim-rewards").click();
  await confirm(page);
  const after = await positions(r.address, 4);
  expect(BigInt(after.walletTokenBalance)).toBeGreaterThan(BigInt(before.walletTokenBalance));
  expect(after.quota).toBe(before.quota);
  await page.getByRole("button", { name: en.v31.checkpoint, exact: true }).click();
  await confirm(page);
  const nonce = await client.readContract({ address: r.token as Address, abi: tokenAbi, functionName: "rewardNonce" });
  expect(nonce as bigint).toBeGreaterThan(1n);
  await expect(page.getByRole("button", { name: en.v31.claimFees, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: en.v31.claimVesting, exact: true })).toHaveCount(0);
  const atlas = await findRaise("ATLAS");
  await page.goto(`/raise/${atlas.address}`);
  await connect(page, 3);
  const builderBefore = await positions(atlas.address, 3);
  await page.getByRole("button", { name: en.v31.claimVesting, exact: true }).click();
  await confirm(page);
  expect(BigInt((await positions(atlas.address, 3)).walletTokenBalance)).toBeGreaterThan(
    BigInt(builderBefore.walletTokenBalance),
  );
  await expect(page.getByRole("button", { name: en.v31.claimFees, exact: true })).toHaveCount(0);
  // Fees sweep into the launch's own governed treasury, which holds the 10% allocation locked on a schedule.
  await page.goto(`/raise/${atlas.address}?tab=governance`);
  await expect(page.getByTestId("treasury-panel")).toBeVisible();
  const treasuryBefore = await detail(atlas.address);
  expect(BigInt(treasuryBefore.treasury.tokenBalance)).toBe(BigInt(treasuryBefore.config.supply) / 10n);
  expect(BigInt(treasuryBefore.treasury.lockedTokens)).toBeGreaterThan(0n);
  const pendingFees = BigInt(treasuryBefore.feeAccruals.treasury);
  expect(pendingFees).toBeGreaterThan(0n);
  await page.getByRole("button", { name: en.v31.claimFees, exact: true }).click();
  await confirm(page);
  const treasuryAfter = await detail(atlas.address);
  expect(BigInt(treasuryAfter.treasury.quoteBalance)).toBe(BigInt(treasuryBefore.treasury.quoteBalance) + pendingFees);
  await audit(page, "raise-stage3-treasury", true);
});

test("F — wizard validates and creates an Escrow Launch with signed v2 metadata", async ({ page }) => {
  await page.goto("/create");
  await connect(page, 3);
  await fillWizard(page, true);
  await expect(page.getByTestId("create-submit")).toBeEnabled();
  await page.getByTestId("create-submit").click();
  await page.getByTestId("confirm-transaction").click();
  await page.waitForURL(/\/raise\/0x[\da-f]{40}/i);
  const drawer = page.getByTestId("transaction-drawer");
  if (await drawer.isVisible()) await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Frontier Lab", exact: true })).toBeVisible();
  await audit(page, "create-success", true);
  const address = page.url().match(/0x[\da-f]{40}/i)![0];
  const r = await detail(address);
  expect(r.phase).toBe("Stage1");
  expect(r.template).toBe("ESCROW_LAUNCH");
  expect(r.description).toBe("A launch created through the v3.1 frontend.");
  expect(r.profile?.imageUrl, "the image uploaded in the wizard is on the project").toMatch(/\/v2\/uploads\/[\da-f]{64}\.png$/);
  expect(r.config.stage1Length).toBe(String(30 * 86400));
});

test("G — all routes and required standalone console command are clean", async ({ page }) => {
  const listed = await findRaise("SIGNAL"),
    refunded = await findRaise("PILOT");
  const paths = [
    "/",
    "/portfolio",
    "/protocol",
    "/create",
    `/raise/${budget.address}`,
    `/raise/${listed.address}`,
    `/raise/${refunded.address}`,
  ];
  const problems: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(String(error)));
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") problems.push(request.url());
  });
  for (const path of [...paths, "/dev", `/raise/${budget.address}/manage`]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("main h1")).toBeVisible();
  }
  expect(problems).toEqual([]);
  const output = execFileSync("node", ["e2e/console-check.mjs", WEB_URL, ...paths], {
    encoding: "utf8",
    timeout: 120000,
  });
  writeFileSync(`${TMP_DIR}console-check.log`, output);
  writeFileSync("e2e/console-routes.json", JSON.stringify(paths, null, 2) + "\n");
  console.log(output);
});

test("H — stage strip, vocabulary and overflow at 390/1280 in en/zh/es", async ({ page, context }) => {
  const fresh = await findRaise("FRONT"),
    listed = await findRaise("SIGNAL"),
    refunded = await findRaise("PILOT");
  for (const [locale, messages] of Object.entries({ en, zh, es })) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: WEB_URL }]);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [path, phase] of [
        ["/", ""],
        [`/raise/${fresh.address}`, "Stage1"],
        [`/raise/${budget.address}`, "Stage2"],
        [`/raise/${listed.address}`, "Stage3"],
        [`/raise/${refunded.address}`, "Dissolved"],
      ]) {
        await page.goto(path);
        const strip = page.getByTestId("lifecycle-graph");
        await expect(strip).toBeVisible();
        for (const stage of ["Stage1", "Stage2", "Stage3"] as const)
          await expect(strip.getByTestId(`lifecycle-node-${stage}`)).toContainText(messages.stages[stage].name);
        if (phase) await expect(strip.getByTestId(`lifecycle-node-${phase}`)).toHaveAttribute("data-state", "current");
        const text = await page.locator("body").innerText();
        expect(text).not.toMatch(
          /\b(?:tran[c]he|epo[c]h|opt[-]in|commit[m]ent|final[ ]window|migrat[e]d|gro[w]th|risk[-]free|fail(?:ed|s|ure)?|refund(?:ed|s)?|fallid[ao]s?|reembols\w*)\b|失败|退款/i,
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(200);
        await page.screenshot({
          path: `e2e/screenshots/v31-strip-${phase || "home"}-${locale}-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
  }
});

test("I — builder dissolves, a claim rolls into another project, and a position moves in one transaction", async ({
  page,
}) => {
  const source = await createFixture("Rollover Source", false, 30);
  await fixtureDeposit(5, source, usd(300));
  const claim = (await positions(source.address, 5)).positions[0];
  await warpTo(source.deadlines.start + 15 * 86400 + 60);
  const target = await createFixture("Rollover Target");
  const second = await createFixture("Rollover Second");
  await page.goto(`/raise/${source.address}/manage`);
  await connect(page, 3);
  await page.getByTestId("dissolve").click();
  await confirm(page);
  expect((await detail(source.address)).phase).toBe("Dissolved");
  await page.goto(`/raise/${source.address}`);
  await connect(page, 5);
  await expect(page.getByTestId("dissolution-note")).toContainText("The team dissolved the project");
  await page.getByTestId("rollover-target").selectOption(target.address);
  await audit(page, "raise-dissolved-rollover", true);
  await page.getByTestId("rollover-out-submit").click();
  await confirm(page);
  const moved = await positions(target.address, 5);
  expect(moved.positions).toHaveLength(1);
  const basis = BigInt(moved.positions[0].positionState.basis);
  expect(basis).toBeGreaterThan(0n);
  expect(basis).toBeLessThanOrEqual(BigInt(claim.positionState.basis));
  expect((await positions(source.address, 5)).positions[0].guaranteedClaim.amount).toBe("0");
  await page.goto(`/raise/${second.address}`);
  await page.getByTestId("pay-from-positions").click();
  await page.getByTestId(`rollover-source-${target.address.toLowerCase()}-${moved.positions[0].id}`).click();
  await audit(page, "raise-stage1-rollover-in", true);
  await page.getByTestId("rollover-submit").click();
  await confirm(page);
  expect((await positions(second.address, 5)).positions).toHaveLength(1);
  expect((await positions(target.address, 5)).positions[0].positionState.tokens).toBe("0");
});

test("J — a Stage 3 treasury spend passes a token-holder vote and pays the recipient", async ({ page }) => {
  const r = await findRaise("ATLAS");
  const cfg = await api<{ quote: { address: string } }>("/config");
  await page.goto(`/raise/${r.address}?tab=governance`);
  await connect(page, 3);
  await page.locator("#spend-recipient").fill(actor(3).address);
  await page.locator("#spend-quote").fill("1");
  await page.locator("#spend-uri").fill("https://example.dev/proposals/security-review");
  await page.getByTestId("propose-spend").click();
  await confirm(page);
  const p = (await api<Proposal[]>(`/raises/${r.address}/proposals`)).at(-1)!;
  // Votes count balances at the end of the proposal block; a local chain mines only on demand.
  await client.request({ method: "evm_mine", params: [] } as never);
  await indexed();
  expect(p.mode).toBe("Token");
  expect(p.kind).toBe("Spend");
  await connect(page, 4);
  await page.getByTestId(`proposal-${p.id}`).getByTestId("vote-yes").click();
  await confirm(page);
  expect(BigInt((await api<Proposal[]>(`/raises/${r.address}/proposals`)).at(-1)!.yesWeight)).toBeGreaterThan(0n);
  await audit(page, "raise-stage3-treasury-vote", true);
  await warpTo(Number(p.votingEnds));
  await page.reload();
  await page.getByTestId("finalize").click();
  await confirm(page);
  await warpTo(Number(p.disputeEnds));
  await page.reload();
  const balance = () =>
    client.readContract({
      address: cfg.quote.address as Address,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [actor(3).address],
    }) as Promise<bigint>;
  const before = await balance();
  await page.getByTestId("execute").click();
  await confirm(page);
  expect((await balance()) - before).toBe(usd(1));
});
