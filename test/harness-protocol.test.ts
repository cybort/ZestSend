import { describe, expect, it } from "vitest";
import {
  HARNESS_MESSAGE_MAX_BYTES,
  HARNESS_OUTPUT_CHUNK_MAX,
  PAIR_CODE_LENGTH,
  PairCodeGuard,
  createHarnessMessageId,
  createTrustSigner,
  fingerprintFromPublicKey,
  formatFingerprint,
  fromBase64Url,
  generatePairCode,
  harnessMessage,
  harnessMessageBytes,
  normalizePairCode,
  sliceOutputChunk,
  toBase64Url,
  trustSignaturePayload,
  verifyTrustSignature,
  type HarnessClientMessage,
} from "../src/shared/harness-protocol";

function message(overrides: Partial<HarnessClientMessage> = {}): HarnessClientMessage {
  return { v: 1, id: createHarnessMessageId(), type: "ping", ...overrides } as HarnessClientMessage;
}

describe("harness protocol framing", () => {
  it("accepts well-formed messages and rejects bad envelopes", () => {
    expect(harnessMessage(message())).not.toBeNull();
    expect(harnessMessage(null)).toBeNull();
    expect(harnessMessage("ping")).toBeNull();
    expect(harnessMessage({ v: 2, id: "a", type: "ping" })).toBeNull();
    expect(harnessMessage({ v: 1, id: "", type: "ping" })).toBeNull();
    expect(harnessMessage({ v: 1, id: "a", type: "" })).toBeNull();
    expect(harnessMessage({ v: 1, id: "x".repeat(129), type: "ping" })).toBeNull();
  });

  it("measures encoded size against the control-message budget", () => {
    expect(harnessMessageBytes(message())).toBeLessThan(HARNESS_MESSAGE_MAX_BYTES);
    const big = message({ type: "session.prompt", sessionId: "s", text: "x".repeat(8_000) } as HarnessClientMessage);
    expect(harnessMessageBytes(big)).toBeGreaterThan(HARNESS_MESSAGE_MAX_BYTES);
  });

  it("slices oversized output into bounded chunks", () => {
    const payload = "a".repeat(HARNESS_OUTPUT_CHUNK_MAX * 2 + 5);
    const slices = sliceOutputChunk(payload);
    expect(slices).toHaveLength(3);
    expect(slices.every((slice) => slice.length <= HARNESS_OUTPUT_CHUNK_MAX)).toBe(true);
    expect(slices.join("")).toBe(payload);
  });
});

describe("connection code guard", () => {
  it("generates fixed-length numeric codes", () => {
    const code = generatePairCode();
    expect(code).toMatch(new RegExp(`^\\d{${PAIR_CODE_LENGTH}}$`));
  });

  it("consumes a correct code exactly once", () => {
    let clock = 1_000;
    const guard = new PairCodeGuard(() => clock);
    const code = guard.issue();
    expect(guard.attempt(code)).toBe(true);
    expect(guard.attempt(code)).toBe(false);
  });

  it("expires codes after the TTL", () => {
    let clock = 1_000;
    const guard = new PairCodeGuard(() => clock);
    const code = guard.issue();
    clock += 120_001;
    expect(guard.attempt(code)).toBe(false);
  });

  it("locks after too many wrong attempts and recovers after the lockout", () => {
    let clock = 1_000;
    const guard = new PairCodeGuard(() => clock);
    guard.issue();
    for (let attempt = 0; attempt < 5; attempt += 1) expect(guard.attempt("000000")).toBe(false);
    expect(guard.current().status).toBe("locked");
    const state = guard.current();
    const code = state.status === "active" ? state.code : null;
    if (code) expect(guard.attempt(code)).toBe(false);
    clock += 120_001;
    expect(guard.current().status).toBe("idle");
  });

  it("normalizes formatted input", () => {
    expect(normalizePairCode(" 12-34 56 ")).toBe("123456");
    expect(normalizePairCode("abcdef")).toBe("");
  });
});

describe("trust handshake crypto", () => {
  it("round-trips signatures and rejects tampering", async () => {
    const signer = await createTrustSigner();
    const rawPublicKey = await signer.rawPublicKey();
    const publicKey = toBase64Url(rawPublicKey);
    const payload = trustSignaturePayload("nonce-1", publicKey);
    const signature = await signer.sign(payload);

    expect(await verifyTrustSignature(rawPublicKey, payload, signature)).toBe(true);
    expect(await verifyTrustSignature(rawPublicKey, trustSignaturePayload("nonce-2", publicKey), signature)).toBe(false);
    const other = await createTrustSigner();
    expect(await verifyTrustSignature(await other.rawPublicKey(), payload, signature)).toBe(false);
  });

  it("derives stable display fingerprints", async () => {
    const signer = await createTrustSigner();
    const fingerprint = await fingerprintFromPublicKey(await signer.rawPublicKey());
    expect(fingerprint).toHaveLength(43);
    const display = formatFingerprint(fingerprint);
    expect(display).toMatch(/^([A-Z0-9]{4}-){7}[A-Z0-9]{4}$/);
    expect(formatFingerprint(fingerprint)).toBe(display);
  });

  it("round-trips base64url encoding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });
});
