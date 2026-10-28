export type SharedPlaybackKind = "audio" | "video";

export type SharedPlaybackCommand = "play" | "pause" | "seek" | "rate" | "stop";

export type SharedPlaybackDanmakuMessage = {
  color: string;
  danmakuId: string;
  id: string;
  text: string;
  time: number;
  type: "shared-playback-danmaku";
};

export type SharedPlaybackMessage =
  | {
      currentTime: number;
      duration: number;
      id: string;
      kind: SharedPlaybackKind;
      name: string;
      playbackRate: number;
      playing: boolean;
      type: "shared-playback-state";
    }
  | {
      command: SharedPlaybackCommand;
      currentTime?: number;
      id: string;
      playbackRate?: number;
      type: "shared-playback-command";
    }
  | {
      id: string;
      type: "shared-playback-stopped";
    }
  | SharedPlaybackDanmakuMessage;

const DANMAKU_COLORS = new Set(["#ffffff", "#ffe86a", "#8defff", "#ffad61", "#ff91ca"]);
export const DANMAKU_DURATION_SECONDS = 9;
export const DANMAKU_LANES = 6;

export function isDanmakuText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 40;
}

export function danmakuLane(danmakuId: string): number {
  return [...danmakuId].reduce((total, character) => total + character.charCodeAt(0), 0) % DANMAKU_LANES;
}

export function danmakuIsVisible(danmakuTime: number, playbackTime: number): boolean {
  return danmakuTime <= playbackTime && playbackTime - danmakuTime < DANMAKU_DURATION_SECONDS;
}

export function danmakuProgress(danmakuTime: number, playbackTime: number): number {
  return Math.min(1, Math.max(0, (playbackTime - danmakuTime) / DANMAKU_DURATION_SECONDS));
}

function isFiniteTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlaybackId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function isSharedPlaybackMessage(value: unknown): value is SharedPlaybackMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<SharedPlaybackMessage>;
  if (!isPlaybackId(message.id)) return false;

  if (message.type === "shared-playback-stopped") return true;
  if (message.type === "shared-playback-command") {
    if (message.command !== "play" && message.command !== "pause" && message.command !== "seek" && message.command !== "rate" && message.command !== "stop") return false;
    if (message.currentTime !== undefined && !isFiniteTime(message.currentTime)) return false;
    return message.playbackRate === undefined || (typeof message.playbackRate === "number" && Number.isFinite(message.playbackRate) && message.playbackRate >= 0.25 && message.playbackRate <= 4);
  }

  if (message.type === "shared-playback-danmaku") {
    const danmaku = message as Partial<SharedPlaybackDanmakuMessage>;
    return isDanmakuText(danmaku.text)
      && typeof danmaku.danmakuId === "string"
      && danmaku.danmakuId.length > 0
      && danmaku.danmakuId.length <= 128
      && typeof danmaku.color === "string"
      && DANMAKU_COLORS.has(danmaku.color)
      && isFiniteTime(danmaku.time)
      && danmaku.time <= 86_400;
  }

  return message.type === "shared-playback-state"
    && (message.kind === "audio" || message.kind === "video")
    && typeof message.name === "string"
    && message.name.length > 0
    && message.name.length <= 512
    && isFiniteTime(message.currentTime)
    && isFiniteTime(message.duration)
    && typeof message.playing === "boolean"
    && typeof message.playbackRate === "number"
    && Number.isFinite(message.playbackRate)
    && message.playbackRate >= 0.25
    && message.playbackRate <= 4;
}
