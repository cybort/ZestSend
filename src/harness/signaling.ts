import WebSocket from "ws";
import {
  SIGNALING_HEARTBEAT_CAPABILITY,
  SIGNALING_HEARTBEAT_INTERVAL_MS,
  SIGNALING_HEARTBEAT_REQUEST,
  SIGNALING_HEARTBEAT_RESPONSE,
  type SignalingHeartbeatProtocol,
} from "../shared/signaling-protocol";

export type SignalPayload = {
  candidate?: {
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  };
  description?: { type?: string; sdp?: string };
};

export type SignalingEvents = {
  welcome: { slotId: string; peerSessionId: string; epoch: number; offererSlotId: string; initiator: boolean; peerCount: number; resumeToken?: string };
  signal: SignalPayload;
  negotiate: void;
  peerReady: void;
  peerLeft: void;
  peerDisconnected: void;
  error: { code?: string; message: string };
  closed: void;
};

type Listener<K extends keyof SignalingEvents> = (event: SignalingEvents[K]) => void;

/**
 * Minimal signaling client for the headless daemon. Mirrors the browser
 * session's WebSocket protocol: hello/welcome, signal forwarding, heartbeats
 * (auto-response v3), seat resume, and reconnect with backoff.
 */
export class SignalingClient {
  private socket: WebSocket | null = null;
  private slotId: string | null = null;
  private peerSessionId: string | null = null;
  private epoch = 0;
  private resumeToken: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatMisses = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private heartbeatProtocol: SignalingHeartbeatProtocol = "legacy-json";
  private readonly listeners: { [K in keyof SignalingEvents]: Set<Listener<K>> } = {
    welcome: new Set(),
    signal: new Set(),
    negotiate: new Set(),
    peerReady: new Set(),
    peerLeft: new Set(),
    peerDisconnected: new Set(),
    error: new Set(),
    closed: new Set(),
  };

  constructor(private readonly url: string) {}

  on<K extends keyof SignalingEvents>(event: K, listener: Listener<K>): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  private emit<K extends keyof SignalingEvents>(event: K, payload: SignalingEvents[K]): void {
    for (const listener of this.listeners[event]) listener(payload);
  }

  connect(): void {
    if (this.closed) return;
    this.stopHeartbeat();
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on("open", () => {
      this.send({
        type: "hello",
        mode: this.resumeToken ? "resume-signaling" : "new",
        ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}),
        capabilities: [SIGNALING_HEARTBEAT_CAPABILITY],
      });
    });
    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("close", () => {
      this.stopHeartbeat();
      this.socket = null;
      if (this.closed) return;
      this.scheduleReconnect();
    });
    socket.on("error", () => {
      try { socket.close(); } catch { /* close handler retries */ }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.emit("closed", undefined);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatMisses = 0;
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      this.heartbeatMisses += 1;
      if (this.heartbeatMisses > 3) {
        try { this.socket.close(); } catch { /* reconnect via close handler */ }
        return;
      }
      if (this.heartbeatProtocol === "auto-response-v3") {
        this.socket.send(SIGNALING_HEARTBEAT_REQUEST);
      } else {
        this.send({ type: "ping" });
      }
    }, SIGNALING_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private handleMessage(raw: string): void {
    if (raw === SIGNALING_HEARTBEAT_RESPONSE) {
      this.heartbeatMisses = 0;
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    // The room bumps its epoch on every admission; outgoing signals carry the
    // latest epoch or the server silently drops them.
    if (typeof message.epoch === "number") this.epoch = message.epoch;
    switch (message.type) {
      case "welcome": {
        this.slotId = (message.slotId ?? message.peerId ?? null) as string | null;
        this.peerSessionId = (message.peerSessionId ?? null) as string | null;
        this.epoch = typeof message.epoch === "number" ? message.epoch : 0;
        this.resumeToken = (message.resumeToken ?? this.resumeToken) as string | null;
        this.heartbeatProtocol = message.heartbeatProtocol === "auto-response-v3" ? "auto-response-v3" : "legacy-json";
        this.reconnectAttempt = 0;
        this.startHeartbeat();
        this.emit("welcome", {
          slotId: this.slotId ?? "",
          peerSessionId: this.peerSessionId ?? "",
          epoch: this.epoch,
          offererSlotId: (message.offererSlotId ?? "") as string,
          initiator: Boolean(message.isInitiator) || message.offererSlotId === this.slotId,
          peerCount: typeof message.peerCount === "number" ? message.peerCount : 1,
          resumeToken: this.resumeToken ?? undefined,
        });
        return;
      }
      case "signal": {
        this.emit("signal", (message.payload ?? {}) as SignalPayload);
        return;
      }
      case "negotiate":
        this.emit("negotiate", undefined);
        return;
      case "peer-ready":
        this.emit("peerReady", undefined);
        return;
      case "peer-left":
        this.emit("peerLeft", undefined);
        return;
      case "peer-disconnected":
        this.emit("peerDisconnected", undefined);
        return;
      case "error":
        this.emit("error", { code: message.code as string | undefined, message: String(message.message ?? "signaling error") });
        return;
      case "pong":
        this.heartbeatMisses = 0;
        return;
      default:
        return;
    }
  }

  sendSignal(payload: SignalPayload): void {
    this.send({
      type: "signal",
      epoch: this.epoch,
      fromSlotId: this.slotId ?? undefined,
      peerSessionId: this.peerSessionId ?? undefined,
      payload,
    });
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.send({ type: "leave" }); } catch { /* best effort */ }
    try { this.socket?.close(); } catch { /* already closed */ }
  }
}
