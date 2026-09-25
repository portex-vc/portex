import { expect, test } from "@playwright/test";
import { confirm, connectAs, createFixture, detail, indexed } from "./helpers";

/**
 * Role-gated admin console on the local stack: anvil #0 is the curator (and the API admin), #1 the attester,
 * #2 the council; a backer holds no role. Roles come from chain/API reads, so each account sees only its own
 * sections, and the attester's veto and the council's clear run through the transaction drawer.
 */
test("Admin — curator, attester and council see only their controls; a veto is applied and cleared", async ({
  page,
}) => {
  const fixture = await createFixture("Admin Probe");
  const symbol = fixture.symbol;
  expect(fixture.phase).toBe("Stage1");

  // A backer: no pill, and /admin is a calm page without actions.
  await page.goto("/");
  await connectAs(page, 4);
  await expect(page.getByTestId("admin-pill")).toHaveCount(0);
  await page.goto("/admin");
  await expect(page.getByTestId("admin-outsider")).toBeVisible();
  await expect(page.locator("main button:not([aria-label])")).toHaveCount(0);
  await expect(page.getByTestId("admin-parameters")).toHaveCount(0);
  await expect(page.getByTestId("admin-vetoes")).toHaveCount(0);

  // The deployer is the registry curator and an API admin.
  await connectAs(page, 0);
  await expect(page.getByTestId("admin-pill")).toBeVisible();
  await page.getByTestId("admin-pill").click();
  await expect(page.getByTestId("admin-menu-curator")).toBeVisible();
  await expect(page.getByTestId("admin-menu-apiAdmin")).toBeVisible();
  await expect(page.getByTestId("admin-menu-attester")).toHaveCount(0);
  await page.getByTestId("admin-open").click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId("admin-parameters")).toBeVisible();
  await expect(page.getByTestId("admin-versions")).toBeVisible();
  await expect(page.getByTestId("admin-quote")).toBeVisible();
  await expect(page.getByTestId("admin-vetoes")).toHaveCount(0);
  await expect(page.getByTestId("param-stage1Max")).toHaveText(/60 days/);
  await expect(page.getByTestId("publish-ESCROW_LAUNCH-submit")).toBeEnabled();

  // The parameter editor mirrors the registry's rules and shows the diff before submitting.
  await page.getByTestId("edit-parameters").click();
  await page.getByTestId("param-input-vetoMax").fill("3");
  await expect(page.getByText("At most 2 days.")).toBeVisible();
  await expect(page.getByTestId("submit-parameters")).toBeDisabled();
  await page.getByTestId("param-input-vetoMax").fill("1");
  await expect(page.getByTestId("parameters-diff")).toContainText("Maximum per veto");
  await expect(page.getByTestId("submit-parameters")).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // Run the analyst on the fresh raise, so the attester has a report to cite.
  await page.getByTestId(`analyze-${symbol}`).click();
  await expect(page.getByTestId(`analysis-${symbol}`)).toContainText("Last report", { timeout: 45_000 });
  const drawer = page.getByTestId("transaction-drawer");
  if (await drawer.isVisible()) await page.keyboard.press("Escape");

  // The attester applies a bounded veto that cites the latest report.
  await connectAs(page, 1);
  await expect(page.getByTestId("admin-pill")).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByTestId("admin-vetoes")).toBeVisible();
  await expect(page.getByTestId("admin-parameters")).toHaveCount(0);
  const apply = page.getByTestId(`veto-apply-${symbol}`);
  await expect(apply).toBeEnabled();
  await apply.click();
  await confirm(page);
  await expect(page.getByTestId(`veto-active-${symbol}`)).toContainText("Veto active until");
  await expect.poll(async () => (await detail(fixture.address)).vetoActive).toBe(true);
  // The cooldown now blocks a second veto.
  await expect(apply).toBeDisabled();

  // The council clears it.
  await connectAs(page, 2);
  await page.goto("/admin");
  await expect(page.getByTestId(`veto-apply-${symbol}`)).toHaveCount(0);
  const clear = page.getByTestId(`veto-clear-${symbol}`);
  await expect(clear).toBeEnabled();
  await clear.click();
  await confirm(page);
  await indexed();
  await expect(page.getByTestId(`veto-active-${symbol}`)).toContainText("No active veto");
  await expect.poll(async () => (await detail(fixture.address)).vetoActive).toBe(false);
});
