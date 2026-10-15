/**
 * Versioned control protocol for the remote AI-harness channel.
 *
 * The harness channel is a fifth reliable/ordered WebRTC data channel whose
 * peers are the browser controller and the `harness-daemon` running next to a
 * CLI AI coding agent. This module is the single source of truth shared by
 * both sides; it is environment-agnostic (no DOM, no Node imports).
 */

export const HARNESS_PROTOCOL_VERSION = 1;
export const HARNESS_CHANNEL_NAME = "harness";

/** Control messages stay small; large payloads travel in chunks or on bulk. */
export const HARNESS_MESSAGE_MAX_BYTES = 4_096;
/** Max `data` characters carried by one `output.chunk` / `shell.output`. */
export const HARNESS_OUTPUT_CHUNK_MAX = 3_072;
/** Files up to this size may move inline (base64) over `fs.read` / `fs.write`. */
export const HARNESS_FILE_INLINE_MAX = 512 * 1024;

export const PAIR_CODE_LENGTH = 6;
export const PAIR_CODE_TTL_MS = 120_000;
export const PAIR_CODE_MAX_ATTEMPTS = 5;

export type HarnessPermissionMode = "readonly" | "approve" | "full";
export type HarnessAgentType = "claude-code" | "copilot-cli" | "fake";
export type HarnessSessionState = "starting" | "running" | "waiting-tool" | "done" | "error" | "canceled";
export type HarnessOutputStream = "stdout" | "stderr" | "tool" | "status";
export type HarnessToolRisk = "low" | "medium" | "high";

export type HarnessSnapshotEntry = {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  at: number;
};

export type HarnessToolRequest = {
  requestId: string;
  sessionId: string;
  tool: string;
  argsJson: string;
  risk: HarnessToolRisk;
};

export type HarnessSessionInfo = {
  sessionId: string;
  agentType: HarnessAgentType;
  workspace: string;
  label: string;
  state: HarnessSessionState;
  updatedAt: number;
  pendingApprovals: number;
};

export type HarnessSessionSnapshot = {
  sessionId: string;
  agentType: HarnessAgentType;
  workspace: string;
  label: string;
  state: HarnessSessionState;
  updatedAt: number;
  transcript: HarnessSnapshotEntry[];
  pendingApprovals: HarnessToolRequest[];
};

type BaseMessage = {
  /** Protocol version; both sides reject versions they do not understand. */
  v: number;
  /** Correlation id for request/response pairing. */
  id: string;
};

/* --------------------------------- pairing -------------------------------- */

export type PairCodeMessage = BaseMessage & {
  type: "pair.code";
  /** One-time connection code displayed on the host machine. */
  code: string;
  /** Base64url raw Ed25519 public key of the controller. */
  publicKey: string;
  /** Controller nonce binding the host signature to this pairing attempt. */
  clientNonce: string;
};

export type PairResultMessage = BaseMessage & {
  type: "pair.result";
  ok: boolean;
  /** Base64url raw Ed25519 public key of the host. */
  publicKey?: string;
  /** Grouped display fingerprint of the host key. */
  fingerprint?: string;
  /** Signature over the controller nonce proving possession of the host key. */
  hostSignature?: string;
  error?: "code-expired" | "code-invalid" | "too-many-attempts" | "unauthorized" | "internal";
};

export type TrustChallengeMessage = BaseMessage & {
  type: "trust.challenge";
  /** Base64url random nonce to be signed by the peer. */
  nonce: string;
};

export type TrustResponseMessage = BaseMessage & {
  type: "trust.response";
  /** Echo of the challenged nonce. */
  nonce: string;
  /** Base64url raw Ed25519 public key of the responder. */
  publicKey: string;
  /** Base64url Ed25519 signature over `trustSignaturePayload(nonce, publicKey)`. */
  signature: string;
};

export type HostAuthedMessage = BaseMessage & {
  type: "host.authed";
  fingerprint: string;
};

export type HostInfoMessage = BaseMessage & {
  type: "host.info";
  agentType: HarnessAgentType;
  capabilities: string[];
  permissions: HarnessPermissionMode;
  fingerprint: string;
  pairingRequired: boolean;
};

/* --------------------------------- sessions ------------------------------- */

export type SessionStartMessage = BaseMessage & {
  type: "session.start";
  agentType: HarnessAgentType;
  workspace: string;
  label?: string;
  permissionMode?: HarnessPermissionMode;
};

export type SessionListMessage = BaseMessage & { type: "session.list" };

export type SessionListResultMessage = BaseMessage & {
  type: "session.list";
  sessions: HarnessSessionInfo[];
};

export type SessionSwitchMessage = BaseMessage & {
  type: "session.switch";
  sessionId: string;
};

export type SessionResumeMessage = BaseMessage & {
  type: "session.resume";
  sessionId: string;
};

export type SessionCancelMessage = BaseMessage & {
  type: "session.cancel";
  sessionId: string;
};

export type SessionPromptMessage = BaseMessage & {
  type: "session.prompt";
  sessionId: string;
  text: string;
  /** Optional file references (paths known to the host). */
  attachments?: string[];
};

export type SessionSnapshotMessage = BaseMessage & {
  type: "session.snapshot";
  sessionId: string;
};

export type SessionSnapshotResultMessage = BaseMessage & {
  type: "session.snapshot";
  snapshot: HarnessSessionSnapshot;
};

export type SessionStateMessage = BaseMessage & {
  type: "session.state";
  sessionId: string;
  state: HarnessSessionState;
  detail?: string;
};

export type OutputChunkMessage = BaseMessage & {
  type: "output.chunk";
  sessionId: string;
  /** Monotonic per-session sequence number for gap detection and resync. */
  seq: number;
  stream: HarnessOutputStream;
  data: string;
};

export type OutputDoneMessage = BaseMessage & {
  type: "output.done";
  sessionId: string;
  exitCode?: number;
};

/* ------------------------------ tool approvals ---------------------------- */

export type ToolDecisionMessage = BaseMessage & {
  type: "tool.decision";
  requestId: string;
  allow: boolean;
  /** Optional replacement arguments for an approved call. */
  argsOverride?: string;
};

export type ToolRequestMessage = BaseMessage & {
  type: "tool.request";
  requestId: string;
  sessionId: string;
  tool: string;
  argsJson: string;
  risk: HarnessToolRisk;
};

/* ------------------------------- raw control ------------------------------ */

export type ShellExecMessage = BaseMessage & {
  type: "shell.exec";
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

export type ShellKillMessage = BaseMessage & {
  type: "shell.kill";
  shellId: string;
};

export type ShellOutputMessage = BaseMessage & {
  type: "shell.output";
  shellId: string;
  seq: number;
  stream: "stdout" | "stderr";
  data: string;
  done?: boolean;
};

export type ShellResultMessage = BaseMessage & {
  type: "shell.result";
  shellId: string;
  exitCode: number | null;
  timedOut: boolean;
};

export type FsListMessage = BaseMessage & {
  type: "fs.list";
  path: string;
};

export type FsReadMessage = BaseMessage & {
  type: "fs.read";
  path: string;
};

export type FsWriteMessage = BaseMessage & {
  type: "fs.write";
  path: string;
  /** Base64 file content; must fit HARNESS_FILE_INLINE_MAX. */
  data: string;
  overwrite?: boolean;
};

export type FsResultMessage = BaseMessage & {
  type: "fs.result";
  ok: boolean;
  /** fs.list entries or fs.read content. */
  entries?: Array<{ name: string; kind: "file" | "directory"; size: number }>;
  data?: string;
  error?: string;
};

/* ---------------------------------- control ------------------------------- */

export type PingMessage = BaseMessage & { type: "ping" };
export type PongMessage = BaseMessage & { type: "pong" };

export type AckMessage = BaseMessage & {
  type: "ack";
  /** The message id being acknowledged. */
  ackId: string;
  ok: boolean;
  error?: string;
};

export type ErrorMessage = BaseMessage & {
  type: "error";
  code: "unauthorized" | "unsupported-version" | "permission-denied" | "unknown-session" | "invalid-message" | "internal";
  message: string;
};

/** Messages sent by the browser controller. */
export type HarnessClientMessage =
  | PairCodeMessage
  | TrustChallengeMessage
  | TrustResponseMessage
  | SessionStartMessage
  | SessionListMessage
  | SessionSwitchMessage
  | SessionResumeMessage
  | SessionCancelMessage
  | SessionPromptMessage
  | SessionSnapshotMessage
  | ToolDecisionMessage
  | ShellExecMessage
  | ShellKillMessage
  | FsListMessage
  | FsReadMessage
  | FsWriteMessage
  | PingMessage;

/** Messages sent by the harness host daemon. */
export type HarnessHostMessage =
  | HostInfoMessage
  | PairResultMessage
  | TrustChallengeMessage
  | TrustResponseMessage
  | HostAuthedMessage
  | SessionListResultMessage
  | SessionSnapshotResultMessage
  | SessionStateMessage
  | OutputChunkMessage
  | OutputDoneMessage
  | ToolRequestMessage
  | ShellOutputMessage
  | ShellResultMessage
  | FsResultMessage
  | PongMessage
  | AckMessage
  | ErrorMessage;

export type HarnessMessage = HarnessClientMessage | HarnessHostMessage;

/* --------------------------------- helpers -------------------------------- */

const encoder = new TextEncoder();

export function harnessMessageBytes(message: HarnessMessage): number {
  return encoder.encode(JSON.stringify(message)).byteLength;
}

export function harnessMessageFits(message: HarnessMessage): boolean {
  return harnessMessageBytes(message) <= HARNESS_MESSAGE_MAX_BYTES;
}

let idCounter = 0;

/** Correlation id; unique across peers without coordination. */
export function createHarnessMessageId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
  idCounter += 1;
  return `h-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function harnessMessage(value: unknown): HarnessMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<HarnessMessage> & Record<string, unknown>;
  if (message.v !== HARNESS_PROTOCOL_VERSION) return null;
  if (typeof message.type !== "string" || message.type.length === 0) return null;
  if (typeof message.id !== "string" || message.id.length === 0 || message.id.length > 128) return null;
  return message as HarnessMessage;
}

/** Split oversized output into chunk payloads of at most HARNESS_OUTPUT_CHUNK_MAX. */
export function sliceOutputChunk(data: string): string[] {
  if (data.length <= HARNESS_OUTPUT_CHUNK_MAX) return [data];
  const slices: string[] = [];
  for (let offset = 0; offset < data.length; offset += HARNESS_OUTPUT_CHUNK_MAX) {
    slices.push(data.slice(offset, offset + HARNESS_OUTPUT_CHUNK_MAX));
  }
  return slices;
}

/* ------------------------------ connection code --------------------------- */

/** Cryptographically random numeric connection code of PAIR_CODE_LENGTH digits. */
export function generatePairCode(): string {
  const digits = new Uint8Array(PAIR_CODE_LENGTH);
  globalThis.crypto.getRandomValues(digits);
  let code = "";
  for (const digit of digits) code += String(digit % 10);
  return code;
}

/** Normalize user input: digits only, trimmed to the code length. */
export function normalizePairCode(input: string): string {
  return input.replace(/\D/g, "").slice(0, PAIR_CODE_LENGTH);
}

export type PairCodeState =
  | { status: "idle" }
  | { status: "active"; code: string; issuedAt: number; attempts: number }
  | { status: "locked"; lockedAt: number };

/**
 * Host-side guard enforcing single use, TTL, and brute-force limits.
 * Time is injected so tests do not sleep.
 */
export class PairCodeGuard {
  private state: PairCodeState = { status: "idle" };

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = PAIR_CODE_TTL_MS,
    private readonly maxAttempts: number = PAIR_CODE_MAX_ATTEMPTS,
    private readonly lockoutMs: number = PAIR_CODE_TTL_MS,
  ) {}

  issue(): string {
    const code = generatePairCode();
    this.state = { status: "active", code, issuedAt: this.now(), attempts: 0 };
    return code;
  }

  current(): PairCodeState {
    if (this.state.status === "active" && this.now() - this.state.issuedAt > this.ttlMs) {
      this.state = { status: "idle" };
    } else if (this.state.status === "locked" && this.now() - this.state.lockedAt > this.lockoutMs) {
      this.state = { status: "idle" };
    }
    return this.state;
  }

  /** Validate an attempt. A correct code is consumed (single use). */
  attempt(input: string): boolean {
    const state = this.current();
    if (state.status === "locked") return false;
    if (state.status !== "active") return false;
    const ok = normalizePairCode(input) === state.code && normalizePairCode(input).length === PAIR_CODE_LENGTH;
    if (ok) {
      this.state = { status: "idle" };
      return true;
    }
    const attempts = state.attempts + 1;
    this.state = attempts >= this.maxAttempts
      ? { status: "locked", lockedAt: this.now() }
      : { status: "active", code: state.code, issuedAt: state.issuedAt, attempts };
    return false;
  }
}

/* --------------------------------- trust crypto --------------------------- */

export interface TrustSigner {
  /** Raw 32-byte Ed25519 public key. */
  rawPublicKey(): Promise<Uint8Array>;
  sign(payload: Uint8Array): Promise<Uint8Array>;
}

/** Canonical payload signed during the trust handshake. */
export function trustSignaturePayload(nonce: string, publicKey: string): Uint8Array {
  return encoder.encode(`zestsend-harness-trust-v1:${nonce}:${publicKey}`);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Base64url SHA-256 digest of a raw public key. */
export async function fingerprintFromPublicKey(rawPublicKey: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", rawPublicKey as unknown as BufferSource);
  return toBase64Url(new Uint8Array(digest));
}

/** Grouped uppercase display form, e.g. `A1B2-C3D4-...` (first 32 characters). */
export function formatFingerprint(fingerprint: string): string {
  const clean = fingerprint.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 32);
  return (clean.match(/.{1,4}/g) ?? []).join("-");
}

export async function verifyTrustSignature(
  rawPublicKey: Uint8Array,
  payload: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      rawPublicKey as unknown as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature as unknown as BufferSource,
      payload as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

/** Generate an Ed25519 signer backed by WebCrypto (works in browser and Node). */
export async function createTrustSigner(): Promise<TrustSigner & { privateKey: CryptoKey }> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const rawPublicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    privateKey: pair.privateKey,
    rawPublicKey: async () => rawPublicKey,
    sign: async (payload) => {
      const signature = await globalThis.crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, payload as unknown as BufferSource);
      return new Uint8Array(signature);
    },
  };
}

export type StoredTrustSigner = {
  /** Base64url PKCS#8 private key. */
  privateKey: string;
  /** Base64url raw public key. */
  publicKey: string;
};

/** Export a signer so it can be persisted to disk or localStorage. */
export async function exportTrustSigner(signer: TrustSigner & { privateKey?: CryptoKey }): Promise<StoredTrustSigner> {
  if (!signer.privateKey) throw new Error("signer does not expose its private key");
  const privateKey = await globalThis.crypto.subtle.exportKey("pkcs8", signer.privateKey);
  return {
    privateKey: toBase64Url(new Uint8Array(privateKey)),
    publicKey: toBase64Url(await signer.rawPublicKey()),
  };
}

/** Restore a signer persisted by `exportTrustSigner`. */
export async function importTrustSigner(stored: StoredTrustSigner): Promise<TrustSigner> {
  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    fromBase64Url(stored.privateKey) as unknown as BufferSource,
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const rawPublicKey = fromBase64Url(stored.publicKey);
  return {
    rawPublicKey: async () => rawPublicKey,
    sign: async (payload) => {
      const signature = await globalThis.crypto.subtle.sign({ name: "Ed25519" }, privateKey, payload as unknown as BufferSource);
      return new Uint8Array(signature);
    },
    privateKey,
  } as TrustSigner & { privateKey: CryptoKey };
}
