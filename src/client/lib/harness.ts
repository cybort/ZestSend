import {
  HARNESS_PROTOCOL_VERSION,
  createHarnessMessageId,
  createTrustSigner,
  exportTrustSigner,
  fingerprintFromPublicKey,
  formatFingerprint,
  fromBase64Url,
  harnessMessage,
  importTrustSigner,
  toBase64Url,
  trustSignaturePayload,
  verifyTrustSignature,
  type HarnessHostMessage,
  type HarnessMessage,
  type HarnessOutputStream,
  type HarnessPermissionMode,
  type HarnessAgentType,
  type HarnessSessionInfo,
  type HarnessSessionSnapshot,
  type HarnessSessionState,
  type HarnessToolRequest,
  type StoredTrustSigner,
  type TrustSigner,
} from "../../shared/harness-protocol";

export type HarnessAuthState = "idle" | "pairing-required" | "verifying" | "authed" | "failed";

export type HarnessClientEvents = {
  status: {
    auth: HarnessAuthState;
    detail?: string;
    fingerprint?: string;
    agentType?: string;
    permissions?: HarnessPermissionMode;
  };
  sessions: { sessions: HarnessSessionInfo[] };
  sessionState: { sessionId: string; state: HarnessSessionState; detail?: string };
  output: { sessionId: string; seq: number; stream: HarnessOutputStream; data: string };
  outputDone: { sessionId: string; exitCode?: number };
  toolRequest: HarnessToolRequest;
  snapshot: { snapshot: HarnessSessionSnapshot };
  shell: { shellId: string; seq: number; stream: "stdout" | "stderr"; data: string; done?: boolean; exitCode?: number | null; timedOut?: boolean };
  fs: { ok: boolean; entries?: Array<{ name: string; kind: "file" | "directory"; size: number }>; data?: string; error?: string };
  error: { message: string };
};

type Listener<K extends keyof HarnessClientEvents> = (event: HarnessClientEvents[K]) => void;

const IDENTITY_KEY = "zestsend-harness-identity";
const HOST_KEY = "zestsend-harness-host";
const QUEUE_KEY = "zestsend-harness-queue";

type PinnedHost = { publicKey: string; fingerprint: string };

function loadStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing may refuse storage; the session still works in-memory.
  }
}

/**
 * Browser-side controller for the remote AI harness channel: TOFU pairing
 * with connection codes, pinned-host verification, session mirroring with
 * snapshot resync, and an offline queue backed by the encrypted mailbox.
 */
export class HarnessController {
  private signer: TrustSigner | null = null;
  private pinnedHost: PinnedHost | null = null;
  private hostInfo: {
    agentType?: string;
    permissions?: HarnessPermissionMode;
    fingerprint?: string;
    pairingRequired?: boolean;
  } = {};
  private authState: HarnessAuthState = "idle";
  private hostChallenge: string | null = null;
  private clientNonce = createHarnessMessageId();
  private clientChallenge = createHarnessMessageId();
  private pairCodeSent = false;
  private hostVerified = false;
  private authed = false;
  private sessions: HarnessSessionInfo[] = [];
  private activeSessionId: string | null = null;
  private readonly seqBySession = new Map<string, number>();
  /**
   * Commands that could not ride the data channel are kept locally until the
   * harness channel is back: localStorage keeps them across page reloads, so
   * prompts and approvals are not lost while the peer is offline.
   */
  private readonly offlineQueue: string[] = loadStored<string[]>(QUEUE_KEY) ?? [];

  private readonly listeners: { [K in keyof HarnessClientEvents]: Set<Listener<K>> } = {
    status: new Set(),
    sessions: new Set(),
    sessionState: new Set(),
    output: new Set(),
    outputDone: new Set(),
    toolRequest: new Set(),
    snapshot: new Set(),
    shell: new Set(),
    fs: new Set(),
    error: new Set(),
  };

  constructor(private readonly sendRaw: (json: string) => boolean) {}

  on<K extends keyof HarnessClientEvents>(event: K, listener: Listener<K>): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  private emit<K extends keyof HarnessClientEvents>(event: K, payload: HarnessClientEvents[K]): void {
    for (const listener of this.listeners[event]) listener(payload);
  }

  private send(message: Record<string, unknown>): void {
    const ok = this.sendRaw(JSON.stringify(message));
    if (!ok) {
      const json = JSON.stringify(message);
      if (json.length <= 4_096 && this.offlineQueue.length < 200) {
        this.offlineQueue.push(json);
        saveStored(QUEUE_KEY, this.offlineQueue);
      }
    }
  }

  private base(): { v: number; id: string } {
    return { v: HARNESS_PROTOCOL_VERSION, id: createHarnessMessageId() };
  }

  private setAuth(auth: HarnessAuthState, detail?: string): void {
    this.authState = auth;
    this.emit("status", {
      auth,
      detail,
      fingerprint: this.hostInfo.fingerprint,
      agentType: this.hostInfo.agentType,
      permissions: this.hostInfo.permissions,
    });
  }

  get status(): HarnessAuthState {
    return this.authState;
  }

  get permissions(): HarnessPermissionMode | undefined {
    return this.hostInfo.permissions;
  }

  get fingerprint(): string | null {
    return this.pinnedHost?.fingerprint ?? this.hostInfo.fingerprint ?? null;
  }

  get sessionList(): HarnessSessionInfo[] {
    return this.sessions;
  }

  get focusedSessionId(): string | null {
    return this.activeSessionId;
  }

  /** Load (or create) the persistent controller identity. */
  async ensureIdentity(): Promise<void> {
    if (this.signer) return;
    const stored = loadStored<StoredTrustSigner>(IDENTITY_KEY);
    this.signer = stored ? await importTrustSigner(stored) : await createTrustSigner();
    if (!stored) saveStored(IDENTITY_KEY, await exportTrustSigner(this.signer as TrustSigner & { privateKey: CryptoKey }));
    this.pinnedHost = loadStored<PinnedHost>(HOST_KEY);
  }

  /** Called when the harness data channel opens. */
  async start(): Promise<void> {
    await this.ensureIdentity();
    this.authed = false;
    this.hostVerified = false;
    this.pairCodeSent = false;
    this.clientNonce = createHarnessMessageId();
    this.clientChallenge = createHarnessMessageId();
    // Open with our own challenge so the host proves its key on every connect.
    this.send({ ...this.base(), type: "trust.challenge", nonce: this.clientChallenge });
  }

  async submitPairCode(code: string): Promise<void> {
    await this.ensureIdentity();
    this.pairCodeSent = true;
    this.send({
      ...this.base(),
      type: "pair.code",
      code: code.replace(/\D/g, ""),
      publicKey: toBase64Url(await this.signer!.rawPublicKey()),
      clientNonce: this.clientNonce,
    });
    this.setAuth("verifying", "Verifying pairing code");
  }

  private async respondToChallenge(nonce: string): Promise<void> {
    if (!this.signer) return;
    const publicKey = toBase64Url(await this.signer.rawPublicKey());
    const signature = await this.signer.sign(trustSignaturePayload(nonce, publicKey));
    this.send({ ...this.base(), type: "trust.response", nonce, publicKey, signature: toBase64Url(signature) });
  }

  /** Entry point for every harness-channel message. */
  async handleHostMessage(raw: string): Promise<void> {
    let message: HarnessMessage | null = null;
    try {
      message = harnessMessage(JSON.parse(raw));
    } catch {
      return;
    }
    if (!message) return;
    const hostMessage = message as HarnessHostMessage;
    switch (hostMessage.type) {
      case "host.info": {
        this.hostInfo = {
          agentType: hostMessage.agentType,
          permissions: hostMessage.permissions,
          fingerprint: hostMessage.fingerprint,
          pairingRequired: hostMessage.pairingRequired,
        };
        if (this.pinnedHost && this.pinnedHost.fingerprint !== hostMessage.fingerprint) {
          this.setAuth("failed", "Host fingerprint changed. Re-pairing required.");
          this.pinnedHost = null;
          saveStored(HOST_KEY, null);
          this.setAuth("pairing-required", "Host fingerprint changed");
          return;
        }
        this.setAuth(this.pinnedHost ? "verifying" : "pairing-required");
        return;
      }
      case "trust.challenge": {
        this.hostChallenge = hostMessage.nonce;
        if (this.pinnedHost || this.pairCodeSent) await this.respondToChallenge(hostMessage.nonce);
        return;
      }
      case "trust.response": {
        // Host proof in response to our challenge.
        const pinned = this.pinnedHost;
        const key = pinned?.publicKey;
        if (key && hostMessage.publicKey === key) {
          const valid = await verifyTrustSignature(
            fromBase64Url(key),
            trustSignaturePayload(hostMessage.nonce, hostMessage.publicKey),
            fromBase64Url(hostMessage.signature),
          );
          this.hostVerified = valid;
          if (!valid) this.setAuth("failed", "Host proof invalid");
        }
        return;
      }
      case "pair.result": {
        if (!hostMessage.ok) {
          this.pairCodeSent = false;
          this.setAuth("pairing-required", hostMessage.error ?? "Pairing failed");
          this.emit("error", { message: hostMessage.error ?? "Pairing failed" });
          return;
        }
        if (hostMessage.publicKey && hostMessage.hostSignature) {
          const valid = await verifyTrustSignature(
            fromBase64Url(hostMessage.publicKey),
            trustSignaturePayload(this.clientNonce, hostMessage.publicKey),
            fromBase64Url(hostMessage.hostSignature),
          );
          if (!valid) {
            this.setAuth("failed", "Host pairing proof invalid");
            return;
          }
          // Trust on first use: pin the host key after a verified pairing.
          const fingerprint = formatFingerprint(await fingerprintFromPublicKey(fromBase64Url(hostMessage.publicKey)));
          this.pinnedHost = { publicKey: hostMessage.publicKey, fingerprint };
          saveStored(HOST_KEY, this.pinnedHost);
          this.hostVerified = true;
          this.hostInfo.fingerprint = fingerprint;
        }
        return;
      }
      case "host.authed": {
        this.authed = true;
        this.setAuth("authed");
        this.flushOfflineQueue();
        this.requestSessions();
        return;
      }
      case "session.list": {
        // A second peer opening the same panel can deliver a list whose
        // payload is missing or not an array. The workspace indexes it
        // immediately, so a non-array must not reach the UI.
        const sessions = Array.isArray(hostMessage.sessions) ? hostMessage.sessions : [];
        this.sessions = sessions;
        this.emit("sessions", { sessions });
        return;
      }
      case "session.snapshot": {
        this.seqBySession.set(hostMessage.snapshot.sessionId, hostMessage.snapshot.transcript.length);
        this.emit("snapshot", { snapshot: hostMessage.snapshot });
        return;
      }
      case "session.state": {
        this.sessions = this.sessions.map((session) =>
          session.sessionId === hostMessage.sessionId ? { ...session, state: hostMessage.state } : session);
        this.emit("sessionState", { sessionId: hostMessage.sessionId, state: hostMessage.state, detail: hostMessage.detail });
        return;
      }
      case "output.chunk": {
        const expected = this.seqBySession.get(hostMessage.sessionId) ?? 0;
        if (hostMessage.seq > expected + 1) {
          // Gap detected (e.g. reconnect); resync via snapshot.
          this.requestSnapshot(hostMessage.sessionId);
        }
        this.seqBySession.set(hostMessage.sessionId, Math.max(expected, hostMessage.seq));
        this.emit("output", {
          sessionId: hostMessage.sessionId,
          seq: hostMessage.seq,
          stream: hostMessage.stream,
          data: hostMessage.data,
        });
        return;
      }
      case "output.done": {
        this.sessions = this.sessions.map((session) =>
          session.sessionId === hostMessage.sessionId ? { ...session, state: "done" as HarnessSessionState } : session);
        this.emit("outputDone", { sessionId: hostMessage.sessionId, exitCode: hostMessage.exitCode });
        return;
      }
      case "tool.request": {
        this.emit("toolRequest", {
          requestId: hostMessage.requestId,
          sessionId: hostMessage.sessionId,
          tool: hostMessage.tool,
          argsJson: hostMessage.argsJson,
          risk: hostMessage.risk,
        });
        return;
      }
      case "shell.output": {
        this.emit("shell", {
          shellId: hostMessage.shellId,
          seq: hostMessage.seq,
          stream: hostMessage.stream,
          data: hostMessage.data,
          done: hostMessage.done,
        });
        return;
      }
      case "shell.result": {
        this.emit("shell", {
          shellId: hostMessage.shellId,
          seq: 0,
          stream: "stdout",
          data: "",
          done: true,
          exitCode: hostMessage.exitCode,
          timedOut: hostMessage.timedOut,
        });
        return;
      }
      case "fs.result": {
        this.emit("fs", {
          ok: hostMessage.ok,
          entries: hostMessage.entries,
          data: hostMessage.data,
          error: hostMessage.error,
        });
        return;
      }
      case "ack": {
        if (!hostMessage.ok) this.emit("error", { message: hostMessage.error ?? "Command rejected" });
        return;
      }
      case "error": {
        this.emit("error", { message: hostMessage.message });
        return;
      }
      default:
        return;
    }
  }

  private flushOfflineQueue(): void {
    while (this.offlineQueue.length > 0) {
      const json = this.offlineQueue.shift();
      if (json) this.sendRaw(json);
    }
    saveStored(QUEUE_KEY, this.offlineQueue);
  }

  private requestSessions(): void {
    this.send({ ...this.base(), type: "session.list" });
  }

  requestSnapshot(sessionId: string): void {
    this.send({ ...this.base(), type: "session.snapshot", sessionId });
  }

  focusSession(sessionId: string): void {
    this.activeSessionId = sessionId;
  }

  async startSession(workspace: string, label?: string): Promise<void> {
    this.send({
      ...this.base(),
      type: "session.start",
      agentType: (this.hostInfo.agentType ?? "fake") as HarnessAgentType,
      workspace,
      label,
    });
  }

  prompt(sessionId: string, text: string, attachments?: string[]): void {
    this.send({ ...this.base(), type: "session.prompt", sessionId, text, attachments });
  }

  decide(requestId: string, allow: boolean, argsOverride?: string): void {
    this.send({ ...this.base(), type: "tool.decision", requestId, allow, argsOverride });
  }

  cancel(sessionId: string): void {
    this.send({ ...this.base(), type: "session.cancel", sessionId });
  }

  resume(sessionId: string): void {
    this.send({ ...this.base(), type: "session.resume", sessionId });
    this.requestSnapshot(sessionId);
  }

  refresh(): void {
    this.requestSessions();
    if (this.activeSessionId) this.requestSnapshot(this.activeSessionId);
  }

  shellExec(command: string, cwd?: string, timeoutMs?: number): void {
    this.send({ ...this.base(), type: "shell.exec", command, cwd, timeoutMs });
  }

  fsList(path: string): void {
    this.send({ ...this.base(), type: "fs.list", path });
  }

  fsRead(path: string): void {
    this.send({ ...this.base(), type: "fs.read", path });
  }

  fsWrite(path: string, dataBase64: string, overwrite = true): void {
    this.send({ ...this.base(), type: "fs.write", path, data: dataBase64, overwrite });
  }

  ping(): void {
    this.send({ ...this.base(), type: "ping" });
  }
}
