import type {
  HarnessSessionState,
  HarnessSnapshotEntry,
} from "../../shared/harness-protocol";
import { AdapterEmitter, type AgentAdapter, type AdapterFactoryOptions } from "./types";

export type FakeToolScript = {
  tool: string;
  argsJson: string;
  risk?: "low" | "medium" | "high";
  /** Output emitted when the request is approved. */
  onAllow?: string;
  /** Output emitted when the request is denied. */
  onDeny?: string;
};

export type FakeSessionScript = {
  /** Output lines streamed after each prompt, one per tick. */
  reply?: string[];
  /** Tool requests raised after `reply` finishes. */
  tools?: FakeToolScript[];
  /** Delay between streamed lines (ms). */
  tickMs?: number;
  exitCode?: number;
};

/**
 * Scriptable adapter used by unit tests and e2e runs so the control plane can
 * be exercised without a real coding agent.
 */
export class FakeAdapter implements AgentAdapter {
  readonly agentType = "fake" as const;
  readonly workspace: string;
  private readonly label: string;
  private readonly emitter = new AdapterEmitter();
  private readonly entries: HarnessSnapshotEntry[] = [];
  private stateValue: HarnessSessionState = "starting";
  private script: FakeSessionScript;
  private pendingTool: { requestId: string; request: FakeToolScript } | null = null;
  private runToken = 0;

  constructor(options: AdapterFactoryOptions & { script?: FakeSessionScript }) {
    this.workspace = options.workspace;
    this.label = options.label;
    this.script = options.script ?? { reply: ["fake assistant reply"], tools: [] };
  }

  get state(): HarnessSessionState {
    return this.stateValue;
  }

  transcript(limit = 200): HarnessSnapshotEntry[] {
    return this.entries.slice(-limit);
  }

  private push(role: HarnessSnapshotEntry["role"], text: string): void {
    this.entries.push({ role, text, at: Date.now() });
    if (this.entries.length > 2_000) this.entries.splice(0, this.entries.length - 2_000);
  }

  private setState(state: HarnessSessionState, detail?: string): void {
    this.stateValue = state;
    this.emitter.emit("state", { state, detail });
  }

  async start(): Promise<void> {
    this.setState("running", `fake session ready (${this.label})`);
  }

  async prompt(text: string): Promise<void> {
    this.push("user", text);
    const token = ++this.runToken;
    this.setState("running");
    const tick = this.script.tickMs ?? 1;
    for (const line of this.script.reply ?? []) {
      if (token !== this.runToken) return;
      this.push("assistant", line);
      this.emitter.emit("output", { stream: "stdout", data: `${line}\n` });
      await new Promise((resolve) => setTimeout(resolve, tick));
    }
    if (token !== this.runToken) return;
    const tool = this.script.tools?.[0];
    if (tool) {
      const requestId = `fake-tool-${Date.now()}`;
      this.pendingTool = { requestId, request: tool };
      this.push("tool", `${tool.tool}(${tool.argsJson})`);
      this.setState("waiting-tool");
      this.emitter.emit("toolRequest", {
        requestId,
        tool: tool.tool,
        argsJson: tool.argsJson,
        risk: tool.risk ?? "medium",
      });
      return;
    }
    this.setState("done");
    this.emitter.emit("done", { exitCode: this.script.exitCode ?? 0 });
  }

  async decide(requestId: string, allow: boolean): Promise<boolean> {
    if (!this.pendingTool || this.pendingTool.requestId !== requestId) return false;
    const { request } = this.pendingTool;
    this.pendingTool = null;
    const line = allow ? request.onAllow ?? `${request.tool} allowed` : request.onDeny ?? `${request.tool} denied`;
    this.push("tool", line);
    this.emitter.emit("output", { stream: "tool", data: `${line}\n` });
    this.setState("done");
    this.emitter.emit("done", { exitCode: allow ? 0 : 1 });
    return true;
  }

  async cancel(): Promise<void> {
    this.runToken += 1;
    this.pendingTool = null;
    this.setState("canceled");
    this.emitter.emit("done", { exitCode: 130 });
  }

  on: AgentAdapter["on"] = (event, listener) => this.emitter.on(event, listener);
}

export function fakeAdapterFactory(script?: FakeSessionScript) {
  return (options: AdapterFactoryOptions) => new FakeAdapter({ ...options, script });
}
