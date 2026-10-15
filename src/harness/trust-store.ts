import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createTrustSigner,
  exportTrustSigner,
  importTrustSigner,
  type StoredTrustSigner,
  type TrustSigner,
} from "../shared/harness-protocol";

export type TrustStoreShape = {
  /** This host's persisted identity. */
  host: StoredTrustSigner;
  /** Pinned controller identity, if any. */
  controllerPublicKey?: string;
};

/**
 * Host-side trust store. The controller's Ed25519 public key is pinned after
 * the first connection-code pairing; a different key must pair again.
 */
export class TrustStore {
  private constructor(
    readonly path: string,
    private shape: TrustStoreShape,
    readonly signer: TrustSigner & { privateKey?: CryptoKey },
  ) {}

  static async load(stateDir: string): Promise<TrustStore> {
    const path = join(stateDir, "trust.json");
    mkdirSync(dirname(path), { recursive: true });
    let shape: TrustStoreShape | null = null;
    try {
      shape = JSON.parse(readFileSync(path, "utf8")) as TrustStoreShape;
    } catch {
      shape = null;
    }
    const signer = shape?.host
      ? await importTrustSigner(shape.host)
      : await createTrustSigner();
    const store = new TrustStore(path, shape ?? { host: await exportTrustSigner(signer) }, signer);
    store.save();
    return store;
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.shape));
    } catch {
      // Best effort; the in-memory store stays authoritative.
    }
  }

  get controllerPublicKey(): string | null {
    return this.shape.controllerPublicKey ?? null;
  }

  pinController(publicKey: string): void {
    this.shape = { ...this.shape, host: this.shape.host, controllerPublicKey: publicKey };
    this.save();
  }

  revokeController(): void {
    this.shape = { host: this.shape.host };
    this.save();
  }
}

export function appendAuditLog(stateDir: string, event: Record<string, unknown>): void {
  try {
    const path = join(stateDir, "audit.log");
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    writeFileSync(path, `${line}\n`, { flag: "a" });
  } catch {
    // Auditing must never break control flow.
  }
}
