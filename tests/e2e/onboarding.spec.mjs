import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test("first run, onboarding, dirty confirmation and cleanup", async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), "raycoder-browser-e2e-"));
  const project = join(parent, "new-project");
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Choose where to work" })).toBeVisible();
    await expect(page.getByText("UI ready · agents disabled")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open existing folder" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create new project" })).toBeVisible();

    await page.getByRole("button", { name: "Open existing folder" }).click();
    await expect(page.getByRole("heading", { name: "Open a workspace" })).toBeVisible();
    await page.locator("#project-dialog button[value=cancel]").click();

    await page.getByRole("button", { name: "Create new project" }).click();
    await page.locator("#new-project-path").fill(project);
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page.locator("#inspection")).toContainText("missing");
    await expect(page.locator("#inspection")).toContainText("empty root commit");
    await page.locator("#save-project").click();
    await expect(page.locator("#project-name")).toHaveText("new-project");
    await expect(page.getByText(/main · [a-f0-9]{10} · clean/u)).toBeVisible();
    expect(execFileSync("git", ["log", "-1", "--format=%an <%ae>|%s"], { cwd: project, encoding: "utf8" }).trim())
      .toBe("raycoder <raycoder@local.invalid>|chore: initialize raycoder project");

    await page.getByRole("button", { name: "Planning", exact: true }).click();
    await expect(page.getByText("Provider unavailable", { exact: true })).toBeVisible();
    await expect(page.locator("#planning-message")).toBeDisabled();
    await expect(page.locator("#spec-title")).toBeEnabled();

    await page.getByRole("button", { name: "Project selector" }).click();
    await page.getByRole("button", { name: "Refresh diagnostics" }).click();
    await expect(page.getByText("Ready to execute")).toBeVisible();
    await page.locator("#projects [data-project]").click();
    await expect(page.getByRole("heading", { name: "new-project" })).toBeVisible();

    await page.getByRole("button", { name: "Planning", exact: true }).click();
    await page.locator("#planning-message").fill("Plan a conversational release slice");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".message.assistant")).toContainText("Fake turn 1");
    await page.getByRole("button", { name: "Generate SPEC from conversation" }).click();
    const generatedSpec = page.locator(".artifact-card").filter({ hasText: "spec v1" });
    await expect(generatedSpec).toContainText("Deterministic specification");
    await page.locator("#spec-summary").fill("Corrected in the structured editor.");
    await page.getByRole("button", { name: "Save as new revision" }).click();
    const editedSpec = page.locator(".artifact-card").filter({ hasText: "spec v2" });
    await expect(editedSpec).toContainText("Corrected in the structured editor.");
    await editedSpec.getByRole("button", { name: "Approve this revision" }).click();

    await page.getByRole("button", { name: "Generate tickets from approved SPEC" }).click();
    const generatedTickets = page.locator(".artifact-card").filter({ hasText: "tickets v1" });
    await expect(generatedTickets).toContainText("plan-core");
    await page.locator("[data-plan-description]").first().fill("Corrected ticket description.");
    await page.getByRole("button", { name: "Validate and save revision" }).click();
    await expect(page.locator(".artifact-card").filter({ hasText: "tickets v2" })).toContainText("plan-core");
    await page.getByRole("button", { name: "Generate tickets from approved SPEC" }).click();
    const regeneratedTickets = page.locator(".artifact-card").filter({ hasText: "tickets v3" });
    await expect(regeneratedTickets).toContainText("plan-ui");
    await regeneratedTickets.getByRole("button", { name: "Approve this revision" }).click();
    await regeneratedTickets.getByRole("button", { name: "Confirm DAG and create tickets" }).click();
    await expect(regeneratedTickets).toContainText("confirmed");

    await page.reload();
    await page.locator("#projects [data-project]").click();
    await page.getByRole("button", { name: "Planning", exact: true }).click();
    await expect(page.locator(".message.user")).toContainText("Plan a conversational release slice");
    await expect(page.locator(".artifact-card").filter({ hasText: "spec v2" })).toBeVisible();
    await expect(page.locator(".artifact-card").filter({ hasText: "tickets v3" })).toContainText("confirmed");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Validate and save" }).click();
    await page.getByRole("button", { name: "Planning", exact: true }).click();
    await expect(page.locator(".message.user")).toContainText("Plan a conversational release slice");

    await page.getByRole("button", { name: "Overview", exact: true }).click();
    writeFileSync(join(project, "local-only.txt"), "outside ticket workspace\n", "utf8");
    await expect(page.getByText(/main · [a-f0-9]{10} · dirty/u)).toBeVisible({ timeout: 8_000 });
    await page.getByRole("button", { name: "Tickets", exact: true }).click();
    await page.locator("#ticket-title").fill("Browser ticket");
    await page.locator("#ticket-description").fill("Exercise the dirty checkout choice");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Continue from committed HEAD");
      await dialog.accept();
    });
    const browserTicket = page.locator(".card").filter({ hasText: "Browser ticket" });
    await browserTicket.getByRole("button", { name: "Run", exact: true }).click();
    await expect(browserTicket.getByText("BLOCKED", { exact: true })).toBeVisible();
    await expect(browserTicket.getByText(/base_checkout_dirty/u)).toBeVisible();
    rmSync(join(project, "local-only.txt"), { force: true });
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await expect(page.getByText(/main · [a-f0-9]{10} · clean/u)).toBeVisible({ timeout: 8_000 });
    await page.getByRole("button", { name: "Tickets", exact: true }).click();
    await browserTicket.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(browserTicket.getByText("DONE", { exact: true })).toBeVisible();

    writeFileSync(join(project, "local-preserved.txt"), "cleanup must preserve the checkout\n", "utf8");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Build cleanup plan" }).click();
    await expect(page.getByRole("heading", { name: "Cleanup project data" })).toBeVisible();
    await page.locator("#cleanup-dialog button[value=cancel]").click();
    await expect(page.locator("#cleanup-dialog")).not.toBeVisible();

    await page.getByRole("button", { name: "Build cleanup plan" }).click();
    const phrase = await page.locator("#cleanup-phrase").getAttribute("placeholder");
    await page.locator("#cleanup-phrase").fill(phrase ?? "");
    await page.getByRole("button", { name: "Delete selected data" }).click();
    await expect(page.getByRole("heading", { name: "Choose where to work" })).toBeVisible();
    expect(existsSync(join(project, ".raycoder"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" })).toContain("?? local-preserved.txt");
  } finally {
    try {
      rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // The E2E host releases any open Windows handles when Playwright stops it.
    }
  }
});
