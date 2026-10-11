import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Background-tab resilience: the page reports itself hidden while the test
 * drives it. The stub validates that hidden-state code paths keep the
 * connection and transfers alive; real browser timer throttling cannot be
 * emulated headlessly.
 */

async function installVisibilityStub(page: Page) {
  await page.addInitScript(() => {
    let state = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
    Object.defineProperty(window, "__zestsendSetVisibility", {
      configurable: false,
      value: (next: string) => {
        state = next;
        document.dispatchEvent(new Event("visibilitychange"));
      },
    });
  });
}

async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((next) => {
    (window as unknown as Window & { __zestsendSetVisibility: (state: string) => void }).__zestsendSetVisibility(next);
  }, state);
}

async function installPeerProbe(page: Page) {
  await page.addInitScript(() => {
    const nativeConstructor = window.RTCPeerConnection;
    const probe = { peers: [] as RTCPeerConnection[] };
    Object.defineProperty(window, "__zestsendPeerProbe", { configurable: false, value: probe });
    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      value: new Proxy(nativeConstructor, {
        construct(target, args, newTarget) {
          const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
          probe.peers.push(peer);
          return peer;
        },
      }),
    });
  });
}

async function peerCount(page: Page) {
  return page.evaluate(() => (window as unknown as Window & { __zestsendPeerProbe: { peers: RTCPeerConnection[] } })
    .__zestsendPeerProbe.peers.filter((peer) => peer.sctp !== null).length);
}

async function openChat(page: Page) {
  const composer = page.getByRole("textbox", { name: "Write a message" });
  if (await composer.isVisible().catch(() => false)) return composer;
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(composer).toBeVisible();
  return composer;
}

async function sendChat(page: Page, text: string) {
  const composer = await openChat(page);
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

async function createRoomPeer(page: Page, roomId: string) {
  await page.route("**/api/turn/credentials", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    json: { error: "TURN credentials are not configured." },
  }));
  await page.goto(`/en/room/${roomId}`);
}

async function createPair(browser: Browser, roomId: string) {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await Promise.all([installPeerProbe(alice), installPeerProbe(bob)]);
  await Promise.all([installVisibilityStub(alice), installVisibilityStub(bob)]);
  await createRoomPeer(bob, roomId);
  await createRoomPeer(alice, roomId);
  await openChat(alice);
  await openChat(bob);
  await expect(alice.getByRole("textbox", { name: "Write a message" })).toBeEnabled();
  await expect(bob.getByRole("textbox", { name: "Write a message" })).toBeEnabled();
  await expect.poll(() => peerCount(alice)).toBeGreaterThan(0);
  await expect.poll(() => peerCount(bob)).toBeGreaterThan(0);
  return { alice, aliceContext, bob, bobContext };
}

test.describe("background tab keep-alive", () => {
  test("keeps the connection and completes a file transfer while the sender is hidden", async ({ browser }) => {
    test.setTimeout(180_000);
    const roomId = String(Math.floor(100000 + Math.random() * 900000));
    const pair = await createPair(browser, roomId);
    try {
      const alicePeerCount = await peerCount(pair.alice);
      await setVisibility(pair.alice, "hidden");

      // The hidden side must keep receiving chat without dropping the peer.
      await sendChat(pair.bob, "chat-while-peer-hidden");
      await openChat(pair.alice);
      await expect(pair.alice.getByText("chat-while-peer-hidden", { exact: true })).toBeVisible();
      await expect.poll(() => peerCount(pair.alice)).toBe(alicePeerCount);

      // The hidden side drives the transfer: throttling-tolerant pacing must
      // pump the whole payload without a visible page.
      await pair.alice.getByRole("button", { name: "Files" }).click();
      await pair.alice.locator('input[type="file"]').setInputFiles({
        name: "background-sender.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(16 * 1024 * 1024, 0x42),
      });
      await pair.bob.getByRole("button", { name: "Files" }).click();
      await expect(pair.bob.getByRole("button", { name: "Receive" })).toBeVisible({ timeout: 20_000 });
      await pair.bob.getByRole("button", { name: "Receive" }).click();
      await expect(pair.bob.getByText("Transfer complete", { exact: true })).toBeVisible({ timeout: 90_000 });

      // Returning to the foreground probes liveness and keeps the same peer.
      await setVisibility(pair.alice, "visible");
      await expect.poll(() => peerCount(pair.alice)).toBe(alicePeerCount);
      await sendChat(pair.alice, "chat-after-foreground");
      await openChat(pair.bob);
      await expect(pair.bob.getByText("chat-after-foreground", { exact: true })).toBeVisible();
    } finally {
      await pair.aliceContext.close();
      await pair.bobContext.close();
    }
  });

  test("does not tear down the socket when the page reports hidden", async ({ browser }) => {
    test.setTimeout(120_000);
    const roomId = String(Math.floor(100000 + Math.random() * 900000));
    const pair = await createPair(browser, roomId);
    try {
      const alicePeerCount = await peerCount(pair.alice);
      await setVisibility(pair.alice, "hidden");
      // Heartbeats continue while hidden; misses are tolerated instead of
      // closing the socket (widened limit is unit-tested in test/background.test.ts).
      await pair.alice.waitForTimeout(5_000);
      await expect(pair.alice.getByRole("status")).toHaveCount(0);
      await expect.poll(() => peerCount(pair.alice)).toBe(alicePeerCount);
      await sendChat(pair.bob, "socket-survived-hidden-period");
      await openChat(pair.alice);
      await expect(pair.alice.getByText("socket-survived-hidden-period", { exact: true })).toBeVisible();
    } finally {
      await pair.aliceContext.close();
      await pair.bobContext.close();
    }
  });
});
