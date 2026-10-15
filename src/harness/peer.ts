import { RTCPeerConnection, type RTCDataChannel } from "werift";
import type { SignalPayload } from "./signaling";

export const DATA_CHANNELS: Array<{ label: string; ordered: boolean }> = [
  { label: "control", ordered: true },
  { label: "interactive", ordered: true },
  { label: "harness", ordered: true },
  { label: "bulk", ordered: false },
  { label: "collaboration", ordered: true },
];

export type PeerEvents = {
  channelOpen: { label: string; channel: RTCDataChannel };
  channelClose: { label: string };
  description: { type?: string; sdp?: string };
  candidate: NonNullable<SignalPayload["candidate"]>;
  connected: void;
  failed: void;
};

type Listener<K extends keyof PeerEvents> = (event: PeerEvents[K]) => void;

/**
 * werift-based peer connection mirroring the browser session's channel set.
 * The daemon answers offers from the browser and creates the offer when the
 * room elects it as the initiator.
 */
export class WeriftPeer {
  private pc: RTCPeerConnection | null = null;
  private readonly channels = new Map<string, RTCDataChannel>();
  private pendingCandidates: Array<NonNullable<SignalPayload["candidate"]>> = [];
  private hasRemoteDescription = false;
  private readonly listeners: { [K in keyof PeerEvents]: Set<Listener<K>> } = {
    channelOpen: new Set(),
    channelClose: new Set(),
    description: new Set(),
    candidate: new Set(),
    connected: new Set(),
    failed: new Set(),
  };

  constructor(private readonly iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = []) {}

  on<K extends keyof PeerEvents>(event: K, listener: Listener<K>): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  private emit<K extends keyof PeerEvents>(event: K, payload: PeerEvents[K]): void {
    for (const listener of this.listeners[event]) listener(payload);
  }

  get connectionState(): string {
    return this.pc?.connectionState ?? "new";
  }

  channel(label: string): RTCDataChannel | null {
    return this.channels.get(label) ?? null;
  }

  private ensurePeer(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.emit("connected", undefined);
      if (pc.connectionState === "failed") this.emit("failed", undefined);
    };
    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate) return;
      this.emit("candidate", {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      });
    };
    pc.ondatachannel = (event) => this.attach(event.channel);
    return pc;
  }

  private attach(channel: RTCDataChannel): void {
    this.channels.set(channel.label, channel);
    channel.onopen = () => {
      this.emit("channelOpen", { label: channel.label, channel });
    };
    channel.onclose = () => {
      this.channels.delete(channel.label);
      this.emit("channelClose", { label: channel.label });
    };
  }

  /** Called when the room elects this daemon as the offerer. */
  async createOffer(): Promise<void> {
    const pc = this.ensurePeer();
    for (const { label, ordered } of DATA_CHANNELS) {
      if (!this.channels.has(label)) {
        const channel = pc.createDataChannel(label, { ordered });
        this.attach(channel);
      }
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (pc.localDescription) {
      this.emit("description", { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
    }
  }

  /** Called when the browser offers; produces the answer via `description`. */
  async acceptOffer(description: { type?: string; sdp?: string }): Promise<void> {
    const pc = this.ensurePeer();
    await pc.setRemoteDescription({ type: description.type as "offer", sdp: description.sdp ?? "" });
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (pc.localDescription) {
      this.emit("description", { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
    }
  }

  async acceptAnswer(description: { type?: string; sdp?: string }): Promise<void> {
    const pc = this.ensurePeer();
    await pc.setRemoteDescription({ type: description.type as "answer", sdp: description.sdp ?? "" });
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
  }

  private async flushPendingCandidates(): Promise<void> {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) await this.addCandidateNow(candidate);
  }

  async addCandidate(candidate: NonNullable<SignalPayload["candidate"]>): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.addCandidateNow(candidate);
  }

  private async addCandidateNow(candidate: NonNullable<SignalPayload["candidate"]>): Promise<void> {
    const pc = this.ensurePeer();
    try {
      await pc.addIceCandidate({
        candidate: candidate.candidate ?? "",
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      });
    } catch {
      // Tolerate out-of-order or stale candidates.
    }
  }

  close(): void {
    this.pendingCandidates = [];
    this.hasRemoteDescription = false;
    for (const channel of this.channels.values()) {
      try { channel.close(); } catch { /* already closed */ }
    }
    this.channels.clear();
    try { this.pc?.close(); } catch { /* already closed */ }
    this.pc = null;
  }
}
