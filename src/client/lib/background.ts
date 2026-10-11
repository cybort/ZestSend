/**
 * Background-tab resilience helpers.
 *
 * Browsers throttle timers in hidden tabs (Chrome: >=1s, then >=1min after
 * five minutes) and freeze discarded tabs entirely. These helpers keep the
 * connection and transfer paths honest about that: pure decision functions
 * are unit-testable, and the DOM-touching parts are small and isolated.
 *
 * DOM access goes through globalThis so this module also compiles in the
 * test/worker projects, which do not include the DOM lib.
 */

type VisibilityDocument = {
  visibilityState?: string;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
};

type WakeLockContainer = {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
};

function domDocument(): VisibilityDocument | undefined {
  return (globalThis as unknown as { document?: VisibilityDocument }).document;
}

function domNavigator(): WakeLockContainer | undefined {
  return (globalThis as unknown as { navigator?: WakeLockContainer }).navigator;
}

/** Heartbeat misses are usually false alarms while hidden (timers, not the socket, are throttled). */
export function heartbeatMissLimit(baseLimit: number, pageHidden: boolean): number {
  return pageHidden ? baseLimit * 4 : baseLimit;
}

/** How often background stats collection may run while the page is hidden. */
export const BACKGROUND_STATS_INTERVAL_MS = 30_000;

export function isPageHidden(): boolean {
  return domDocument()?.visibilityState === "hidden";
}

export function onVisibilityChange(listener: (visible: boolean) => void): () => void {
  const doc = domDocument();
  if (!doc) return () => undefined;
  const handler = () => listener(doc.visibilityState !== "hidden");
  doc.addEventListener("visibilitychange", handler);
  return () => doc.removeEventListener("visibilitychange", handler);
}

type WakeLockSentinel = {
  release: () => Promise<void>;
  released: boolean;
  type: string;
};

/**
 * Holds a Screen Wake Lock while media is active so capture and playback
 * survive background tabs and screen dimming. Re-acquires after
 * visibilitychange because the browser releases the lock on hide.
 */
export class WakeLockManager {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  private detach: (() => void) | null = null;

  constructor() {
    this.detach = onVisibilityChange((visible) => {
      if (visible && this.wanted) void this.acquire();
    });
  }

  setWanted(wanted: boolean): void {
    this.wanted = wanted;
    if (wanted) void this.acquire();
    else void this.release();
  }

  private async acquire(): Promise<void> {
    const wakeLock = domNavigator()?.wakeLock;
    if (!wakeLock?.request) return;
    try {
      this.sentinel = await wakeLock.request("screen");
    } catch {
      this.sentinel = null;
    }
  }

  private async release(): Promise<void> {
    const sentinel = this.sentinel;
    this.sentinel = null;
    try {
      await sentinel?.release();
    } catch {
      // The sentinel may already be released by the browser.
    }
  }

  destroy(): void {
    this.wanted = false;
    this.detach?.();
    this.detach = null;
    void this.release();
  }
}
