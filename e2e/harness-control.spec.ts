import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = "http://127.0.0.1:8787";

function startDaemon(roomId: string, stateDir: string): Promise<{ child: ChildProcess; readCode: () => string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [
        join("node_modules", "tsx", "dist", "cli.mjs"),
        join("src", "harness", "main.ts"),
        "--room", roomId,
        "--server", SERVER,
        "--agent", "fake",
        "--permission", "full",
        "--state-dir", stateDir,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let code: string | null = null;
    let settled = false;
    const deadline = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`daemon did not print a pairing code. output:\n${output}`));
      }
    }, 30_000);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) console.log(`[harness-daemon] ${line}`);
      const match = output.match(/pairing code: (\d{6})/);
      if (match && !settled) {
        code = match[1];
        settled = true;
        clearTimeout(deadline);
        resolve({ child, readCode: () => code });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        reject(error);
      }
    });
  });
}

test.describe("remote AI harness control", () => {
  test("pairs with the connection code and drives an agent session end to end", async ({ page }) => {
    const roomId = String(Math.floor(100000 + Math.random() * 900000));
    const stateDir = mkdtempSync(join(tmpdir(), "zestsend-e2e-harness-"));
    const daemon = await startDaemon(roomId, stateDir);
    try {
      await page.goto(`/en/room/${roomId}`);
      await page.getByRole("button", { name: "Remote", exact: true }).click();

      // Pairing: the daemon's one-time connection code authorizes the controller.
      const codeInput = page.getByPlaceholder("6-digit code");
      await expect(codeInput).toBeVisible();
      await codeInput.fill(daemon.readCode() ?? "");
      await page.getByRole("button", { name: "Authorize" }).click();
      await expect(page.getByText("Authorized", { exact: true })).toBeVisible();

      // Start an agent session on the host.
      await page.getByPlaceholder("Workspace path on the host").fill("session-one-workspace");
      await page.getByRole("button", { name: /Start session/ }).click();
      await expect(page.getByRole("button", { name: /fake · session-one-workspace/ })).toBeVisible();

      // Prompt flows to the fake agent and streams output back.
      await page.getByPlaceholder(/Send a prompt/).fill("hello-remote-agent");
      await page.getByRole("button", { name: /Send/ }).click();
      await expect(page.getByText("hello-remote-agent", { exact: true })).toBeVisible();
      await expect(page.getByText("hello from fake agent")).toBeVisible();

      // The tool request raised by the fake agent awaits remote approval.
      await expect(page.getByText(/Waiting for approval/)).toBeVisible();
      await page.getByRole("button", { name: "Allow" }).click();
      await expect(page.getByText("shell allowed")).toBeVisible();

      // Raw shell runs because the daemon was started with `full` permissions.
      await page.getByRole("button", { name: "Shell", exact: true }).click();
      await page.getByPlaceholder(/Command to run/).fill("echo harness-e2e");
      await page.getByRole("button", { name: /Run/ }).click();
      await expect(page.getByText("harness-e2e")).toBeVisible();
    } finally {
      daemon.child.kill();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("switches between agent sessions with independent transcripts", async ({ page }) => {
    const roomId = String(Math.floor(100000 + Math.random() * 900000));
    const stateDir = mkdtempSync(join(tmpdir(), "zestsend-e2e-harness-"));
    const daemon = await startDaemon(roomId, stateDir);
    try {
      await page.goto(`/en/room/${roomId}`);
      await page.getByRole("button", { name: "Remote", exact: true }).click();
      const codeInput = page.getByPlaceholder("6-digit code");
      await codeInput.fill(daemon.readCode() ?? "");
      await page.getByRole("button", { name: "Authorize" }).click();
      await expect(page.getByText("Authorized", { exact: true })).toBeVisible();

      await page.getByPlaceholder("Workspace path on the host").fill("session-one-workspace");
      await page.getByRole("button", { name: /Start session/ }).click();
      const chipOne = page.getByRole("button", { name: /fake · session-one-workspace/ });
      await expect(chipOne).toBeVisible();
      await page.getByPlaceholder(/Send a prompt/).fill("first-session-prompt");
      await page.getByRole("button", { name: /Send/ }).click();
      await expect(page.getByText("first-session-prompt", { exact: true })).toBeVisible();

      // Second session runs in parallel with its own transcript.
      await page.getByPlaceholder("Workspace path on the host").fill("session-two-workspace");
      await page.getByRole("button", { name: /Start session/ }).click();
      const chipTwo = page.getByRole("button", { name: /fake · session-two-workspace/ });
      await expect(chipTwo).toBeVisible();
      await chipTwo.click();
      await page.getByPlaceholder(/Send a prompt/).fill("second-session-prompt");
      await page.getByRole("button", { name: /Send/ }).click();
      await expect(page.getByText("second-session-prompt", { exact: true })).toBeVisible();

      // Switching back restores the first session's transcript via snapshot.
      await chipOne.click();
      await expect(page.getByText("first-session-prompt", { exact: true })).toBeVisible();
    } finally {
      daemon.child.kill();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
