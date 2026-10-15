import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createHarnessMessageId,
  sliceOutputChunk,
  type HarnessAgentType,
  type HarnessHostMessage,
  type HarnessSessionInfo,
  type HarnessSessionSnapshot,
  type HarnessSessionState,
  type HarnessSnapshotEntry,
} from "../shared/harness-protocol";
import type { AdapterFactory, AgentAdapter } from "./adapters/types";

type PersistedSession = {
  sessionId: string;
  agentType: HarnessAgentType;
  workspace: string;
  label: string;
  state: HarnessSessionState;
  updatedAt: number;
  transcript: HarnessSnapshotEntry[];
};

type SessionRecord = {
  sessionId: string;
  agentType: HarnessAgentType;
  workspace: string;
  label: string;
  updatedAt: number;
  adapter: AgentAdapter | null;
  transcript: HarnessSnapshotEntry[];
  outputSeq: number;
  pendingApprovals: Map<string, string>;
};

export type SessionManagerOptions = {
  /** Where the session registry is persisted across daemon restarts. */
  statePath: string;
  /** Resolves an agent type to an adapter factory. */
  factories: Partial<Record<HarnessAgentType, AdapterFactory>>;
  /** Outgoing control-plane sink (wired to the harness channel by the dispatcher). */
  send: (message: HarnessHostMessage) => void;
};

/**
 * Runs several agent sessions concurrently on the host. Switching sessions is
 * purely a controller-side focus change: every session keeps streaming.
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly disposers = new Map<string, () => void>();

  constructor(private readonly options: SessionManagerOptions) {
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.options.statePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedSession[];
      for (const entry of parsed.slice(-50)) {
        if (!entry || typeof entry.sessionId !== "string") continue;
        // Spawned adapters do not survive a daemon restart; sessions come back
        // as `done` snapshots that can be resumed explicitly.
        this.sessions.set(entry.sessionId, {
          sessionId: entry.sessionId,
          agentType: entry.agentType,
          workspace: entry.workspace,
          label: entry.label,
          updatedAt: entry.updatedAt,
          adapter: null,
          transcript: Array.isArray(entry.transcript) ? entry.transcript : [],
          outputSeq: 0,
          pendingApprovals: new Map(),
        });
      }
    } catch {
      // First run: no registry yet.
    }
  }

  private persist(): void {
    const entries: PersistedSession[] = [...this.sessions.values()].map((record) => ({
      sessionId: record.sessionId,
      agentType: record.agentType,
      workspace: record.workspace,
      label: record.label,
      state: record.adapter?.state ?? "done",
      updatedAt: record.updatedAt,
      transcript: record.transcript.slice(-200),
    }));
    try {
      mkdirSync(dirname(this.options.statePath), { recursive: true });
      writeFileSync(this.options.statePath, JSON.stringify(entries));
    } catch {
      // Persistence is best effort; the in-memory registry stays authoritative.
    }
  }

  private info(record: SessionRecord): HarnessSessionInfo {
    return {
      sessionId: record.sessionId,
      agentType: record.agentType,
      workspace: record.workspace,
      label: record.label,
      state: record.adapter?.state ?? "done",
      updatedAt: record.updatedAt,
      pendingApprovals: record.pendingApprovals.size,
    };
  }

  private bind(record: SessionRecord, adapter: AgentAdapter): void {
    this.disposers.get(record.sessionId)?.();
    record.adapter = adapter;
    const offOutput = adapter.on("output", ({ stream, data }) => {
      record.updatedAt = Date.now();
      const entry: HarnessSnapshotEntry = {
        role: stream === "tool" ? "tool" : "assistant",
        text: data,
        at: Date.now(),
      };
      record.transcript.push(entry);
      if (record.transcript.length > 2_000) record.transcript.splice(0, record.transcript.length - 2_000);
      for (const slice of sliceOutputChunk(data)) {
        record.outputSeq += 1;
        this.options.send({
          v: 1,
          id: createHarnessMessageId(),
          type: "output.chunk",
          sessionId: record.sessionId,
          seq: record.outputSeq,
          stream,
          data: slice,
        });
      }
      this.persist();
    });
    const offState = adapter.on("state", ({ state, detail }) => {
      record.updatedAt = Date.now();
      this.options.send({
        v: 1,
        id: createHarnessMessageId(),
        type: "session.state",
        sessionId: record.sessionId,
        state,
        detail,
      });
      this.persist();
    });
    const offTool = adapter.on("toolRequest", ({ requestId, tool, argsJson, risk }) => {
      record.pendingApprovals.set(requestId, tool);
      this.options.send({
        v: 1,
        id: createHarnessMessageId(),
        type: "tool.request",
        requestId,
        sessionId: record.sessionId,
        tool,
        argsJson,
        risk,
      });
      this.persist();
    });
    const offDone = adapter.on("done", ({ exitCode }) => {
      record.pendingApprovals.clear();
      this.options.send({
        v: 1,
        id: createHarnessMessageId(),
        type: "output.done",
        sessionId: record.sessionId,
        exitCode: exitCode ?? undefined,
      });
      this.persist();
    });
    this.disposers.set(record.sessionId, () => {
      offOutput(); offState(); offTool(); offDone();
    });
  }

  list(): HarnessSessionInfo[] {
    return [...this.sessions.values()].map((record) => this.info(record));
  }

  get(sessionId: string): HarnessSessionInfo | null {
    const record = this.sessions.get(sessionId);
    return record ? this.info(record) : null;
  }

  async start(agentType: HarnessAgentType, workspace: string, label?: string): Promise<HarnessSessionInfo | null> {
    const factory = this.options.factories[agentType];
    if (!factory) return null;
    const sessionId = createHarnessMessageId();
    const record: SessionRecord = {
      sessionId,
      agentType,
      workspace,
      label: label ?? `${agentType} · ${workspace}`,
      updatedAt: Date.now(),
      adapter: null,
      transcript: [],
      outputSeq: 0,
      pendingApprovals: new Map(),
    };
    this.sessions.set(sessionId, record);
    const adapter = factory({ sessionId, workspace, label: record.label });
    this.bind(record, adapter);
    await adapter.start();
    this.persist();
    return this.info(record);
  }

  private require(sessionId: string): SessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async prompt(sessionId: string, text: string, attachments?: string[]): Promise<boolean> {
    const record = this.require(sessionId);
    if (!record?.adapter) return false;
    record.transcript.push({ role: "user", text, at: Date.now() });
    record.updatedAt = Date.now();
    await record.adapter.prompt(text, attachments);
    this.persist();
    return true;
  }

  async decide(requestId: string, allow: boolean, argsOverride?: string): Promise<boolean> {
    for (const record of this.sessions.values()) {
      if (!record.pendingApprovals.has(requestId)) continue;
      const adapter = record.adapter;
      if (!adapter) return false;
      const ok = await adapter.decide(requestId, allow, argsOverride);
      if (ok) record.pendingApprovals.delete(requestId);
      this.persist();
      return ok;
    }
    return false;
  }

  async cancel(sessionId: string): Promise<boolean> {
    const record = this.require(sessionId);
    if (!record?.adapter) return false;
    await record.adapter.cancel();
    this.persist();
    return true;
  }

  /** Re-open a finished session; the adapter can accept new prompts again. */
  async resume(sessionId: string): Promise<boolean> {
    const record = this.require(sessionId);
    if (!record) return false;
    if (!record.adapter) {
      const factory = this.options.factories[record.agentType];
      if (!factory) return false;
      const adapter = factory({ sessionId, workspace: record.workspace, label: record.label });
      this.bind(record, adapter);
      await adapter.start();
    }
    record.updatedAt = Date.now();
    this.options.send({
      v: 1,
      id: createHarnessMessageId(),
      type: "session.state",
      sessionId,
      state: "running",
      detail: "session resumed",
    });
    this.persist();
    return true;
  }

  snapshot(sessionId: string): HarnessSessionSnapshot | null {
    const record = this.require(sessionId);
    if (!record) return null;
    return {
      sessionId,
      agentType: record.agentType,
      workspace: record.workspace,
      label: record.label,
      state: record.adapter?.state ?? "done",
      updatedAt: record.updatedAt,
      transcript: record.transcript.slice(-200),
      pendingApprovals: [...record.pendingApprovals.entries()].map(([requestId, tool]) => ({
        requestId,
        sessionId,
        tool,
        argsJson: "{}",
        risk: "medium" as const,
      })),
    };
  }

  dispose(): void {
    for (const dispose of this.disposers.values()) dispose();
    this.disposers.clear();
    this.persist();
  }
}
