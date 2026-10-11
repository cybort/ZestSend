import { describe, expect, it } from "vitest";
import {
  BACKGROUND_STATS_INTERVAL_MS,
  WakeLockManager,
  heartbeatMissLimit,
  isPageHidden,
  onVisibilityChange,
} from "../src/client/lib/background";

describe("background-tab helpers", () => {
  it("keeps the base heartbeat miss limit while visible", () => {
    expect(heartbeatMissLimit(4, false)).toBe(4);
    expect(heartbeatMissLimit(1, false)).toBe(1);
  });

  it("widens the heartbeat miss limit while hidden", () => {
    expect(heartbeatMissLimit(4, true)).toBe(16);
    expect(heartbeatMissLimit(1, true)).toBe(4);
  });

  it("throttles background stats collection to a fixed cadence", () => {
    expect(BACKGROUND_STATS_INTERVAL_MS).toBe(30_000);
  });

  it("treats a document-less environment as visible", () => {
    expect(isPageHidden()).toBe(false);
  });

  it("returns a no-op detach when the DOM is unavailable", () => {
    const detach = onVisibilityChange(() => undefined);
    expect(typeof detach).toBe("function");
    expect(() => detach()).not.toThrow();
  });

  it("tolerates wake lock being unavailable", () => {
    const manager = new WakeLockManager();
    expect(() => manager.setWanted(true)).not.toThrow();
    expect(() => manager.setWanted(false)).not.toThrow();
    expect(() => manager.destroy()).not.toThrow();
  });
});
