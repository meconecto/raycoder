import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test("first run, onboarding, dirty confirmation and cleanup", async ({ page }) => {
  test.setTimeout(90_000);
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
    await expect(page.locator("#project-name")).toHaveText("new-project");

    await page.locator("#locale-select").selectOption("es");
    await page.locator("#theme-select").selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(page.locator("#locale-select")).toHaveValue("es");
    await expect(page.locator("#theme-select")).toHaveValue("light");
    await page.locator("#locale-select").selectOption("en");
    await page.locator("#theme-select").selectOption("dark");
    await page.locator("#projects [data-project]").click();

    await page.getByRole("button", { name: "Planning", exact: true }).click();
    await page.locator("#planning-message").fill("[quota-once] Plan a feature without losing my message");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Usage limit reached" })).toBeVisible();
    await expect(page.locator("[data-session-error] details")).toContainText("quota_exhausted");
    await page.reload();
    await page.locator("#projects [data-project]").click();
    await page.getByRole("button", { name: "Planning", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Usage limit reached" })).toBeVisible();
    await page.locator("[data-session-error] [data-planning-retry]").click();
    await expect(page.locator(".message.assistant").filter({ hasText: "[quota-once]" })).toContainText("Fake turn 1");
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(page.getByRole("heading", { name: "0 needs attention" })).toBeVisible();
    await page.getByRole("button", { name: "Planning", exact: true }).click();
    await page.locator("#planning-message").fill("Plan a conversational release slice");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".message.user").filter({ hasText: "Plan a conversational release slice" })).toBeVisible();
    await expect(page.locator(".message.assistant").filter({ hasText: "Plan a conversational release slice" })).toContainText("Fake turn 1");
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
    await expect(page.locator(".message.user").filter({ hasText: "Plan a conversational release slice" })).toBeVisible();
    await expect(page.locator(".artifact-card").filter({ hasText: "spec v2" })).toBeVisible();
    await expect(page.locator(".artifact-card").filter({ hasText: "tickets v3" })).toContainText("confirmed");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Validate and save" }).click();
    await page.getByRole("button", { name: "Planning", exact: true }).click();
    await expect(page.locator(".message.user").filter({ hasText: "Plan a conversational release slice" })).toBeVisible();

    await page.getByRole("button", { name: "Overview", exact: true }).click();
    writeFileSync(join(project, "package.json"), JSON.stringify({
      private: true,
      packageManager: "pnpm@1.0.0",
      scripts: { verify: "fixture" },
    }), "utf8");
    writeFileSync(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    execFileSync("git", ["add", "package.json", "pnpm-lock.yaml"], { cwd: project });
    commitFixture(project, "test: add node stack");
    await expect(page.getByText(/main · [a-f0-9]{10} · clean/u)).toBeVisible({ timeout: 8_000 });
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
    await expect(page.getByRole("heading", { name: "Allow workspace setup and verification?" })).toBeVisible();
    await expect(page.locator("#workspace-approval-commands")).toContainText("pnpm install --frozen-lockfile");
    await expect(page.locator("#workspace-approval-commands")).toContainText("pnpm run verify");
    const firstFingerprint = await page.locator("#workspace-approval-fingerprint").textContent();
    await page.getByRole("button", { name: "Approve for this project" }).click();
    await expect(browserTicket.getByText("BLOCKED", { exact: true })).toBeVisible();
    await expect(browserTicket.getByText(/base_checkout_dirty/u)).toBeVisible();
    rmSync(join(project, "local-only.txt"), { force: true });
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await expect(page.getByText(/main · [a-f0-9]{10} · clean/u)).toBeVisible({ timeout: 8_000 });
    await page.getByRole("button", { name: "Tickets", exact: true }).click();
    await browserTicket.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(browserTicket.getByText("DONE", { exact: true })).toBeVisible();

    await page.locator("#ticket-title").fill("Approval reuse");
    await page.locator("#ticket-description").fill("Reuse the unchanged preparation fingerprint");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const reused = page.locator(".card").filter({ hasText: "Approval reuse" });
    await reused.getByRole("button", { name: "Run", exact: true }).click();
    await expect(reused.getByText("DONE", { exact: true })).toBeVisible();
    await expect(page.locator("#workspace-approval-dialog")).not.toBeVisible();

    writeFileSync(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nrevision: 2\n", "utf8");
    execFileSync("git", ["add", "pnpm-lock.yaml"], { cwd: project });
    commitFixture(project, "test: change lock");
    await page.locator("#ticket-title").fill("Changed lock");
    await page.locator("#ticket-description").fill("Require a new fingerprint approval");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const changedLock = page.locator(".card").filter({ hasText: "Changed lock" });
    await changedLock.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.locator("#workspace-approval-dialog")).toBeVisible();
    expect(await page.locator("#workspace-approval-fingerprint").textContent()).not.toBe(firstFingerprint);
    await page.getByRole("button", { name: "Approve for this project" }).click();
    await expect(changedLock.getByText("DONE", { exact: true })).toBeVisible();

    writeFileSync(join(project, "go.mod"), "module example.test/e2e\n\ngo 1.24\n", "utf8");
    execFileSync("git", ["add", "go.mod"], { cwd: project });
    commitFixture(project, "test: add second stack");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator("#preparation-mode").selectOption("explicit");
    await page.locator("#add-preparation-unit").click();
    await page.locator("[data-preparation-strategy]").nth(1).selectOption("go");
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/preparation/config") && response.request().method() === "PUT"),
      page.getByRole("button", { name: "Save preparation" }).click(),
    ]);
    await expect(page.locator("body")).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator("[data-preparation-unit]")).toHaveCount(2);
    await page.locator("#verification-mode").selectOption("explicit");
    await page.locator("#add-verification-unit").click();
    await page.locator("[data-verification-strategy]").nth(1).selectOption("go");
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/verification/config") && response.request().method() === "PUT"),
      page.getByRole("button", { name: "Save verification" }).click(),
    ]);
    await expect(page.locator("body")).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator("[data-verification-unit]")).toHaveCount(2);
    await page.getByRole("button", { name: "Tickets", exact: true }).click();
    await page.locator("#ticket-title").fill("Multistack ticket");
    await page.locator("#ticket-description").fill("Prepare Node and Go in order");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const multistack = page.locator(".card").filter({ hasText: "Multistack ticket" });
    await multistack.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.locator("#workspace-approval-commands")).toContainText("go mod verify");
    await expect(page.locator("#workspace-approval-commands")).toContainText("go test ./...");
    await page.getByRole("button", { name: "Approve for this project" }).click();
    await expect(multistack.getByText("DONE", { exact: true })).toBeVisible();

    writeFileSync(join(project, "package.json"), JSON.stringify({
      private: true,
      packageManager: "pnpm@1.0.0",
      scripts: { verify: "fixture" },
      raycoderPreparationFailOnce: true,
    }), "utf8");
    execFileSync("git", ["add", "package.json"], { cwd: project });
    commitFixture(project, "test: request one failed preparation");
    await page.locator("#ticket-title").fill("Preparation retry");
    await page.locator("#ticket-description").fill("Preserve and retry a failed setup");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const failedPreparation = page.locator(".card").filter({ hasText: "Preparation retry" });
    await failedPreparation.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByRole("button", { name: "Approve for this project" }).click();
    await expect(failedPreparation.getByText("BLOCKED", { exact: true })).toBeVisible();
    await expect(failedPreparation).toContainText("preparation.failed");
    await failedPreparation.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(failedPreparation.getByText("DONE", { exact: true })).toBeVisible();

    await page.reload();
    await page.locator("#projects [data-project]").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator("#preparation-mode")).toHaveValue("explicit");
    await expect(page.locator("[data-preparation-unit]")).toHaveCount(2);
    await expect(page.locator("#verification-mode")).toHaveValue("explicit");
    await expect(page.locator("[data-verification-unit]")).toHaveCount(2);
    await page.getByRole("button", { name: "Tickets", exact: true }).click();
    await expect(page.locator(".card").filter({ hasText: "Preparation retry" }).getByText("DONE", { exact: true })).toBeVisible();

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

function commitFixture(project, message) {
  execFileSync("git", [
    "-c", "user.name=raycoder e2e",
    "-c", "user.email=e2e@raycoder.local",
    "commit", "-m", message,
  ], { cwd: project });
}
