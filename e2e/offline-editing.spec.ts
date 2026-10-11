import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Offline-editing resilience: while the peer is away the workspace must stay
 * interactive and surface reconnect state in a corner toast instead of the
 * full-screen connection dialog. The signaling route keeps the returning peer
 * out for a deterministic offline window.
 */

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

async function createRoomPeer(page: Page, roomId: string) {
  let blockNewSockets = false;
  let routeRegistered = false;
  const registerSignalingRoute = async () => {
    if (routeRegistered) return;
    await page.routeWebSocket(/\/api\/rooms\/\d{6}\/ws(?:\?.*)?$/, (client) => {
      if (blockNewSockets) {
        client.close({ code: 1001, reason: "Signaling is paused by the test." });
        return;
      }
      const server = client.connectToServer();
      client.onClose(() => server.close({ code: 1001, reason: "Offline window under test." }));
      server.onClose(() => client.close({ code: 1001, reason: "Offline window under test." }));
    });
    routeRegistered = true;
  };
  await page.route("**/api/turn/credentials", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    json: { error: "TURN credentials are not configured." },
  }));
  await page.goto(`/en/room/${roomId}`);

  return {
    async goOffline() {
      blockNewSockets = true;
      await registerSignalingRoute();
      await page.reload();
    },
    async goOnline() {
      blockNewSockets = false;
    },
  };
}

async function createPair(browser: Browser, roomId: string) {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await Promise.all([installPeerProbe(alice), installPeerProbe(bob)]);
  const bobSession = await createRoomPeer(bob, roomId);
  await createRoomPeer(alice, roomId);
  await openChat(alice);
  await openChat(bob);
  await expect(alice.getByRole("textbox", { name: "Write a message" })).toBeEnabled();
  await expect(bob.getByRole("textbox", { name: "Write a message" })).toBeEnabled();
  await expect.poll(() => peerCount(alice)).toBeGreaterThan(0);
  await expect.poll(() => peerCount(bob)).toBeGreaterThan(0);
  return { alice, aliceContext, bob, bobContext, bobSession };
}

test.describe("offline editing", () => {
  test("keeps editing available while the peer is offline and delivers queued messages", async ({ browser }) => {
    test.setTimeout(180_000);
    const roomId = String(Math.floor(100000 + Math.random() * 900000));
    const pair = await createPair(browser, roomId);
    try {
      // The peer goes away and stays away: reload plus blocked signaling keeps
      // a deterministic offline window (same tab session keeps the seat).
      await pair.bobSession.goOffline();

      // Reconnect state surfaces as a corner toast, not a blocking dialog.
      const toast = pair.alice.getByText("Waiting for the other participant to reconnect. You can keep editing.", { exact: true });
      await expect(toast).toBeVisible({ timeout: 30_000 });

      // The workspace stays interactive: the composer is present and usable.
      const composer = pair.alice.getByRole("textbox", { name: "Write a message" });
      await expect(composer).toBeVisible();
      await composer.fill("queued-while-peer-offline");
      await composer.press("Enter");
      await expect(pair.alice.getByText("queued-while-peer-offline", { exact: true })).toBeVisible();

      // The returning peer (same seat after reload) receives the queued message.
      await pair.bobSession.goOnline();
      await openChat(pair.bob);
      await expect(pair.bob.getByText("queued-while-peer-offline", { exact: true })).toBeVisible({ timeout: 60_000 });

      // The toast flips to "Reconnected" and then clears itself.
      await expect(pair.alice.getByText("Reconnected", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(pair.alice.getByText("Reconnected", { exact: true })).toBeHidden({ timeout: 15_000 });
    } finally {
      await pair.aliceContext.close();
      await pair.bobContext.close();
    }
  });
});
