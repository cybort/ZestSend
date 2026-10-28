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
    const composer = alice.getByPlaceholder("向代理发送提示词…");
    const send = alice.getByRole("button", { name: "发送" });
    await expect(composer).toBeVisible();
    await expect(bob.getByPlaceholder("向代理发送提示词…")).toBeVisible();
    const clearsDock = (selector: string) => alice.evaluate((query) => {
      const control = document.querySelector<HTMLElement>(query);
      const dock = document.querySelector<HTMLElement>(".zest-room-dock");
      if (!control || !dock) return false;
      return control.getBoundingClientRect().bottom <= dock.getBoundingClientRect().top + 1;
    }, selector);
    expect(await clearsDock('textarea[placeholder="向代理发送提示词…"]')).toBe(true);
    const panelTab = (name: string) => alice.locator("main").getByRole("button", { name, exact: true });
    await panelTab("终端").click();
    expect(await clearsDock('input[placeholder="在主机上执行的命令…"]')).toBe(true);
    await panelTab("文件").click();
    expect(await clearsDock('input[placeholder="主机工作区内的路径"]')).toBe(true);
    await panelTab("代理").click();
    await expect(send).toBeVisible();
    expect(errors.filter((entry) => entry.includes("reading '0'"))).toEqual([]);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
