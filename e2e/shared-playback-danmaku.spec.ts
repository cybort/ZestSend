import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function openRoom(page: Page, roomId: string) {
  await page.goto(`/zh/room/${roomId}`);
}

async function openWatch(page: Page) {
  await expect(page.getByRole("heading", { name: "端对端连接已建立" })).toBeVisible();
  await page.getByRole("button", { name: "同播", exact: true }).click();
}

test("shared playback danmaku stays on the timeline for both peers", async ({ browser }) => {
  test.setTimeout(120_000);
  const roomId = String(Math.floor(100000 + Math.random() * 900000));
  const aliceContext = await browser.newContext({ locale: "zh-CN" });
  const bobContext = await browser.newContext({ locale: "zh-CN" });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  try {
    await openRoom(alice, roomId);
    await openRoom(bob, roomId);
    await openWatch(alice);
    await openWatch(bob);

    await expect(alice.getByRole("textbox", { name: "弹幕" })).toHaveCount(0);
    const fixture = test.info().outputPath("fixture.webm");
    const recorded = await alice.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      const captured = video.captureStream();
      const recorder = new MediaRecorder(captured, { mimeType: "video/webm" });
      const chunks: Blob[] = [];
      recorder.addEventListener("dataavailable", (event) => { if (event.data.size > 0) chunks.push(event.data); });
      const stopped = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
      recorder.start();
      await new Promise((resolve) => window.setTimeout(resolve, 1_200));
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      video.pause();
      video.srcObject = null;
      const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
      return [...bytes];
    });
    await writeFile(fixture, Buffer.from(recorded));
    const chooser = alice.waitForEvent("filechooser");
    await alice.getByRole("button", { name: "选择本地音频或视频" }).click();
    await (await chooser).setFiles(fixture);
    await expect(alice.getByText("fixture.webm")).toBeVisible();
    await expect(bob.getByText("fixture.webm")).toBeVisible();
    const aliceInput = alice.getByRole("textbox", { name: "弹幕" });
    await expect(aliceInput).toBeVisible();
    await expect(bob.getByRole("textbox", { name: "弹幕" })).toBeVisible();
    const clearsDock = await alice.evaluate(() => {
      const control = document.querySelector<HTMLElement>('input[aria-label="弹幕"]');
      const dock = document.querySelector<HTMLElement>(".zest-room-dock");
      if (!control || !dock) return false;
      return control.getBoundingClientRect().bottom <= dock.getBoundingClientRect().top + 1;
    });
    expect(clearsDock).toBe(true);
    await aliceInput.fill("同步弹幕");
    await alice.getByRole("button", { name: "发送弹幕" }).click();
    await expect(alice.getByText("同步弹幕")).toBeVisible();
    await expect(bob.getByText("同步弹幕")).toBeVisible();
    await alice.getByRole("button", { name: "暂停" }).click();
    const readPosition = (page: Page) => page.evaluate(() => {
      const item = [...document.querySelectorAll("span")].find((element) => element.textContent === "同步弹幕");
      return item ? Number.parseFloat(item.style.left) : Number.NaN;
    });
    await expect.poll(async () => {
      const first = await readPosition(bob);
      await bob.waitForTimeout(400);
      return Math.abs((await readPosition(bob)) - first);
    }).toBeLessThan(0.5);
    const paused = await readPosition(bob);
    await bob.waitForTimeout(1_200);
    expect(await readPosition(bob)).toBeCloseTo(paused, 0);
    const timeline = alice.getByRole("slider", { name: "播放进度" });
    await timeline.fill("0");
    await expect.poll(() => readPosition(bob)).toBeNaN();
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
