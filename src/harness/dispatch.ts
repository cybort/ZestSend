import {
  HARNESS_PROTOCOL_VERSION,
  PairCodeGuard,
  createHarnessMessageId,
  fingerprintFromPublicKey,
  formatFingerprint,
  fromBase64Url,
  harnessMessage,
  toBase64Url,
  trustSignaturePayload,
  verifyTrustSignature,
  type HarnessAgentType,
  type HarnessClientMessage,
  type HarnessHostMessage,
  type HarnessMessage,
  type HarnessPermissionMode,
} from "../shared/harness-protocol";
import type { SessionManager } from "./sessions";
import { checkCommand, runShellCommand, type ShellPolicy } from "./shell";
import type { FsPolicy } from "./fsops";
import { listDirectory, readFile, writeFile } from "./fsops";
import { appendAuditLog, type TrustStore } from "./trust-store";

export type DispatchTransport = {
  send(message: HarnessHostMessage): void;
};

export type DispatcherOptions = {
  transport: DispatchTransport;
  trust: TrustStore;
  sessions: SessionManager;
  shellPolicy: ShellPolicy;
  fsPolicy: FsPolicy;
  pairCodeGuard: PairCodeGuard;
  agentType: HarnessAgentType;
  permission: HarnessPermissionMode;
  /** Called whenever a pairing code is issued so the CLI can display it. */
  onPairCode?: (code: string) => void;
  stateDir: string;
};

type AuthPhase =
  | { phase: "awaiting"; hostChallenge: string; controllerChallenge: string | null }
  | { phase: "code-verified"; claimedControllerKey: string; hostChallenge: string; controllerChallenge: string | null }
  | { phase: "authed"; hostChallenge: string };

/**
 * Control-plane state machine for one harness channel: connection-code
 * pairing, pinned-key trust handshakes, permission-gated command routing.
 */
export class HarnessDispatcher {
  private auth: AuthPhase;
  private readonly activeShells = new Map<string, { kill(): void }>();

  constructor(private readonly options: DispatcherOptions) {
    this.auth = {
      phase: "awaiting",
      hostChallenge: createHarnessMessageId(),
      controllerChallenge: null,
    };
  }

  get authed(): boolean {
    return this.auth.phase === "authed";
  }

  private send(message: HarnessHostMessage): void {
    this.options.transport.send(message);
  }

  private base(): { v: number; id: string } {
    return { v: HARNESS_PROTOCOL_VERSION, id: createHarnessMessageId() };
  }

  private audit(event: Record<string, unknown>): void {
    appendAuditLog(this.options.stateDir, event);
  }

  /** Announce identity and open the handshake. */
  async open(): Promise<void> {
    const { publicKey, fingerprint } = await this.hostIdentity();
    void publicKey;
    this.send({
      ...this.base(),
      type: "host.info",
      agentType: this.options.agentType,
      capabilities: ["sessions", "tool-approval", this.options.permission === "full" ? "shell" : "no-shell"],
      permissions: this.options.permission,
      fingerprint,
      pairingRequired: !this.options.trust.controllerPublicKey,
    });
    this.send({ ...this.base(), type: "trust.challenge", nonce: this.auth.hostChallenge });
  }

  private async hostIdentity(): Promise<{ publicKey: string; fingerprint: string }> {
    const rawPublicKey = await this.options.trust.signer.rawPublicKey();
    const publicKey = toBase64Url(rawPublicKey);
    const fingerprint = formatFingerprint(await fingerprintFromPublicKey(rawPublicKey));
    return { publicKey, fingerprint };
  }

  private error(code: Extract<HarnessHostMessage, { type: "error" }>["code"], message: string): void {
    this.send({ ...this.base(), type: "error", code, message });
  }

  async onMessage(raw: string): Promise<void> {
    let parsed: HarnessMessage | null = null;
    try {
      parsed = harnessMessage(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      this.error("invalid-message", "Malformed harness message.");
      return;
    }
    if (this.auth.phase !== "authed") {
      await this.handleHandshake(parsed as HarnessClientMessage);
      return;
    }
    await this.route(parsed as HarnessClientMessage);
  }

  private async handleHandshake(message: HarnessClientMessage): Promise<void> {
    switch (message.type) {
      case "trust.challenge": {
        const controllerChallenge = message.nonce;
        if (this.auth.phase === "awaiting") {
          this.auth = { ...this.auth, controllerChallenge };
        } else if (this.auth.phase === "code-verified") {
          this.auth = { ...this.auth, controllerChallenge };
        }
        const { publicKey } = await this.hostIdentity();
        const signature = await this.options.trust.signer.sign(trustSignaturePayload(message.nonce, publicKey));
        this.send({
          ...this.base(),
          type: "trust.response",
          nonce: message.nonce,
          publicKey,
          signature: toBase64Url(signature),
        });
        return;
      }
      case "trust.response": {
        await this.verifyController(message);
        return;
      }
      case "pair.code": {
        await this.handlePairCode(message);
        return;
      }
      default:
        this.error("unauthorized", "Complete the pairing handshake first.");
    }
  }

  private async handlePairCode(message: Extract<HarnessClientMessage, { type: "pair.code" }>): Promise<void> {
    const ok = this.options.pairCodeGuard.attempt(message.code);
    if (!ok) {
      const state = this.options.pairCodeGuard.current();
      const error = state.status === "locked" ? "too-many-attempts" as const
        : state.status === "idle" ? "code-expired" as const
        : "code-invalid" as const;
      this.audit({ event: "pair_code_failed", error });
      this.send({ ...this.base(), type: "pair.result", ok: false, error });
      return;
    }
    const { publicKey, fingerprint } = await this.hostIdentity();
    const hostSignature = await this.options.trust.signer.sign(trustSignaturePayload(message.clientNonce, publicKey));
    this.auth = {
      phase: "code-verified",
      claimedControllerKey: message.publicKey,
      hostChallenge: createHarnessMessageId(),
      controllerChallenge: this.auth.phase === "awaiting" ? this.auth.controllerChallenge : null,
    };
    this.audit({ event: "pair_code_ok" });
    this.send({
      ...this.base(),
      type: "pair.result",
      ok: true,
      publicKey,
      fingerprint,
      hostSignature: toBase64Url(hostSignature),
    });
    // Challenge the controller to prove possession of the claimed key.
    this.send({ ...this.base(), type: "trust.challenge", nonce: this.auth.hostChallenge });
  }

  private async verifyController(message: Extract<HarnessClientMessage, { type: "trust.response" }>): Promise<void> {
    if (this.auth.phase === "authed") return;
    const pinned = this.options.trust.controllerPublicKey;
    const expectedKey = this.auth.phase === "code-verified" ? this.auth.claimedControllerKey : pinned;
    if (!expectedKey) {
      this.send({ ...this.base(), type: "pair.result", ok: false, error: "unauthorized" });
      return;
    }
    const expectedNonce = this.auth.hostChallenge;
    if (message.nonce !== expectedNonce || message.publicKey !== expectedKey) {
      this.audit({ event: "trust_verify_failed", reason: "mismatch" });
      this.error("unauthorized", "Trust handshake mismatch.");
      return;
    }
    const valid = await verifyTrustSignature(
      fromBase64Url(expectedKey),
      trustSignaturePayload(message.nonce, message.publicKey),
      fromBase64Url(message.signature),
    );
    if (!valid) {
      this.audit({ event: "trust_verify_failed", reason: "signature" });
      this.error("unauthorized", "Invalid trust signature.");
      return;
    }
    if (this.auth.phase === "code-verified") {
      this.options.trust.pinController(message.publicKey);
    }
    this.auth = { phase: "authed" as const, hostChallenge: this.auth.hostChallenge };
    this.audit({ event: "authed", controller: message.publicKey });
    const { fingerprint } = await this.hostIdentity();
    this.send({ ...this.base(), type: "host.authed", fingerprint });
  }

  private permissionAllows(action: "control" | "write"): boolean {
    const mode = this.options.permission;
    if (action === "write") return mode === "full";
    return mode === "approve" || mode === "full";
  }

  private ack(message: HarnessClientMessage, ok: boolean, error?: string): void {
    this.send({ ...this.base(), type: "ack", ackId: message.id, ok, error });
  }

  private async route(message: HarnessClientMessage): Promise<void> {
    const sessions = this.options.sessions;
    switch (message.type) {
      case "ping":
        this.send({ ...this.base(), type: "pong" });
        return;
      case "session.list":
        this.send({ ...this.base(), type: "session.list", sessions: sessions.list() });
        return;
      case "session.snapshot": {
        const snapshot = sessions.snapshot(message.sessionId);
        if (!snapshot) {
          this.ack(message, false, "unknown-session");
          return;
        }
        this.send({ ...this.base(), type: "session.snapshot", snapshot });
        return;
      }
      case "session.start": {
        if (!this.permissionAllows("control")) { this.ack(message, false, "permission-denied"); return; }
        if (message.agentType !== this.options.agentType) { this.ack(message, false, "unsupported agent type"); return; }
        const info = await sessions.start(message.agentType, message.workspace, message.label);
        this.audit({ event: "session.start", sessionId: info?.sessionId });
        this.ack(message, Boolean(info));
        this.send({ ...this.base(), type: "session.list", sessions: sessions.list() });
        return;
      }
      case "session.prompt": {
        if (!this.permissionAllows("control")) { this.ack(message, false, "permission-denied"); return; }
        const ok = await sessions.prompt(message.sessionId, message.text, message.attachments);
        this.audit({ event: "session.prompt", sessionId: message.sessionId });
        this.ack(message, ok, ok ? undefined : "unknown-session");
        return;
      }
      case "session.cancel": {
        if (!this.permissionAllows("control")) { this.ack(message, false, "permission-denied"); return; }
        this.ack(message, await sessions.cancel(message.sessionId));
        this.send({ ...this.base(), type: "session.list", sessions: sessions.list() });
        return;
      }
      case "session.resume": {
        if (!this.permissionAllows("control")) { this.ack(message, false, "permission-denied"); return; }
        this.ack(message, await sessions.resume(message.sessionId));
        return;
      }
      case "tool.decision": {
        if (!this.permissionAllows("control")) { this.ack(message, false, "permission-denied"); return; }
        const ok = await sessions.decide(message.requestId, message.allow, message.argsOverride);
        this.audit({ event: "tool.decision", requestId: message.requestId, allow: message.allow });
        this.ack(message, ok, ok ? undefined : "unknown-request");
        return;
      }
      case "shell.exec": {
        if (!this.permissionAllows("write")) { this.ack(message, false, "permission-denied"); return; }
        const verdict = checkCommand(message.command, this.options.shellPolicy);
        if (!verdict.ok) {
          this.audit({ event: "shell.denied", command: message.command, reason: verdict.reason });
          this.ack(message, false, verdict.reason);
          return;
        }
        const shellId = createHarnessMessageId();
        let seq = 0;
        const handle = runShellCommand(shellId, message.command, this.options.shellPolicy, (event) => {
          this.send({
            ...this.base(),
            type: "shell.output",
            shellId,
            seq: (seq += 1),
            stream: event.stream,
            data: event.data,
            done: event.done,
          });
        }, message.cwd, message.timeoutMs);
        this.activeShells.set(shellId, handle);
        this.audit({ event: "shell.exec", command: message.command });
        this.ack(message, true);
        handle.done.then(({ exitCode, timedOut }) => {
          this.activeShells.delete(shellId);
          this.send({ ...this.base(), type: "shell.result", shellId, exitCode, timedOut });
        });
        return;
      }
      case "shell.kill": {
        if (!this.permissionAllows("write")) { this.ack(message, false, "permission-denied"); return; }
        const handle = this.activeShells.get(message.shellId);
        handle?.kill();
        this.ack(message, Boolean(handle));
        return;
      }
      case "fs.list": {
        const result = listDirectory(this.options.fsPolicy, message.path);
        this.send({
          ...this.base(),
          type: "fs.result",
          ok: result.ok,
          entries: result.ok ? result.entries : undefined,
          error: result.ok ? undefined : result.error,
        });
        return;
      }
      case "fs.read": {
        const result = readFile(this.options.fsPolicy, message.path);
        this.send({
          ...this.base(),
          type: "fs.result",
          ok: result.ok,
          data: result.ok ? result.data : undefined,
          error: result.ok ? undefined : result.error,
        });
        return;
      }
      case "fs.write": {
        if (!this.permissionAllows("write")) {
          this.send({ ...this.base(), type: "fs.result", ok: false, error: "permission-denied" });
          return;
        }
        const result = writeFile(this.options.fsPolicy, message.path, message.data, message.overwrite);
        this.audit({ event: "fs.write", path: message.path, ok: result.ok });
        this.send({ ...this.base(), type: "fs.result", ok: result.ok, error: result.ok ? undefined : result.error });
        return;
      }
      default:
        this.error("invalid-message", "Unsupported harness message.");
    }
  }

  dispose(): void {
    for (const handle of this.activeShells.values()) handle.kill();
    this.activeShells.clear();
  }
}
