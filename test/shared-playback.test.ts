import { describe, expect, it } from "vitest";
import {
  DANMAKU_DURATION_SECONDS,
  DANMAKU_LANES,
  danmakuIsVisible,
  danmakuLane,
  danmakuProgress,
  isDanmakuText,
  isSharedPlaybackMessage,
} from "../src/client/lib/shared-playback";

const validDanmaku = {
  color: "#ffe86a",
  danmakuId: "comment-1",
  id: "playback-1",
  text: "  hello  ",
  time: 12.5,
  type: "shared-playback-danmaku",
};

describe("shared playback danmaku", () => {
  it("accepts a comment bound to the current playback time", () => {
    expect(isSharedPlaybackMessage(validDanmaku)).toBe(true);
    expect(isDanmakuText("  synced  ")).toBe(true);
  });

  it("rejects comments that are empty, too long, off-palette, or outside the media timeline", () => {
    expect(isSharedPlaybackMessage({ ...validDanmaku, text: "   " })).toBe(false);
    expect(isSharedPlaybackMessage({ ...validDanmaku, text: "x".repeat(41) })).toBe(false);
    expect(isSharedPlaybackMessage({ ...validDanmaku, color: "#000000" })).toBe(false);
    expect(isSharedPlaybackMessage({ ...validDanmaku, time: -0.1 })).toBe(false);
    expect(isSharedPlaybackMessage({ ...validDanmaku, time: 86_401 })).toBe(false);
    expect(isSharedPlaybackMessage({ ...validDanmaku, danmakuId: "" })).toBe(false);
  });

  it("keeps a comment visible for nine seconds and scrubs its position with playback", () => {
    expect(DANMAKU_DURATION_SECONDS).toBe(9);
    expect(danmakuIsVisible(10, 9.9)).toBe(false);
    expect(danmakuIsVisible(10, 10)).toBe(true);
    expect(danmakuIsVisible(10, 18.9)).toBe(true);
    expect(danmakuIsVisible(10, 19)).toBe(false);
    expect(danmakuProgress(10, 10)).toBe(0);
    expect(danmakuProgress(10, 14.5)).toBeCloseTo(0.5);
    expect(danmakuProgress(10, 30)).toBe(1);
  });

  it("assigns the same lane to both peers from the comment id", () => {
    expect(danmakuLane("comment-1")).toBe(danmakuLane("comment-1"));
    expect(danmakuLane("comment-1")).toBeGreaterThanOrEqual(0);
    expect(danmakuLane("comment-1")).toBeLessThan(DANMAKU_LANES);
  });
});
