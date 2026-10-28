import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

function collectErrors(page: Page, label: string, errors: string[]) {
  page.on("pageerror", (error) => errors.push(`${label} pageerror: ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") errors.push(`${label} console: ${message.text()}`);
  });
}

test("both peers can open the agent tab without crashing", async ({ browser }) => {
  test.setTimeout(120_000);
  const roomId = String(Math.floor(100000 + Math.random() * 900000));
  const errors: string[] = [];
  const aliceContext = await browser.newContext({ locale: "zh-CN" });
  const bobContext = await browser.newContext({ locale: "zh-CN" });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  collectErrors(alice, "alice", errors);
  collectErrors(bob, "bob", errors);
  try {
    await alice.goto(`/zh/room/${roomId}`);
    await bob.goto(`/zh/room/${roomId}`);
    await expect(alice.getByRole("heading", { name: "端对端连接已建立" })).toBeVisible();
    await expect(bob.getByRole("heading", { name: "端对端连接已建立" })).toBeVisible();
    await alice.getByRole("button", { name: "远程", exact: true }).click();
    await bob.getByRole("button", { name: "远程", exact: true }).click();
    await expect(alice.getByRole("button", { name: "代理", exact: true })).toBeVisible();
    await expect(alice.getByText("连接中…")).toBeVisible();
    await expect(bob.getByText("连接中…")).toBeVisible();
    await alice.getByRole("button", { name: "终端", exact: true }).click();
    await bob.getByRole("button", { name: "终端", exact: true }).click();
    await alice.getByRole("button", { name: "代理", exact: true }).click();
    await bob.getByRole("button", { name: "代理", exact: true }).click();
    await expect(alice.getByPlaceholder("向代理发送提示词…")).toBeVisible();
    await expect(bob.getByPlaceholder("向代理发送提示词…")).toBeVisible();
    expect(errors.filter((entry) => entry.includes("reading '0'"))).toEqual([]);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
