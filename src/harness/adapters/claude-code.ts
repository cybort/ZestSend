import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  HarnessSessionState,
  HarnessSnapshotEntry,
} from "../../shared/harness-protocol";
import { AdapterEmitter, type AdapterFactoryOptions, type AgentAdapter } from "./types";

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ChildProcessWithoutNullStreams;

export type ClaudeCodeOptions = AdapterFactoryOptions & {
  /** Path to the `claude` binary. */
  binary?: string;
  /** Extra flags, e.g. ["--permission-mode", "acceptEdits"]. */
  extraArgs?: string[];
  /** Resume a previous Claude Code session id. */
  resumeSessionId?: string;
  spawnFn?: SpawnFn;
};

type StreamEvent = {
  type?: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  };
  result?: string;
  session_id?: string;
  control_request?: {
    id?: string;
    request?: {
      subtype?: string;
      tool_name?: string;
      tool_input?: unknown;
    };
  };
};

/**
 * Claude Code adapter driven through the CLI's bidirectional stream-json
 * protocol. Tool permission prompts arrive as `control_request/can_use_tool`
 * and are forwarded to the remote controller for approval.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentType = "claude-code" as const;
  readonly workspace: string;
  private readonly label: string;
  private readonly options: ClaudeCodeOptions;
  private readonly emitter = new AdapterEmitter();
  private readonly entries: HarnessSnapshotEntry[] = [];
  private stateValue: HarnessSessionState = "starting";
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private remoteSessionId: string | null = null;
  private readonly pendingControl = new Map<string, string>();
  private stdout: string[] = [];

  constructor(options: ClaudeCodeOptions) {
    this.workspace = options.workspace;
    this.label = options.label;
    this.options = options;
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
    const spawnFn = this.options.spawnFn ?? ((command, args, options) => nodeSpawn(command, args, options) as ChildProcessWithoutNullStreams);
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      ...(this.options.resumeSessionId ? ["--resume", this.options.resumeSessionId] : []),
      ...(this.options.extraArgs ?? []),
    ];
    this.child = spawnFn(this.options.binary ?? "claude", args, {
      cwd: this.workspace,
      env: { ...process.env, ...this.options.env } as Record<string, string>,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.emitter.emit("output", { stream: "stderr", data: chunk.toString("utf8") });
    });
    this.child.on("error", (error) => {
      this.push("system", `claude code failed to start: ${(error as Error).message}`);
      this.setState("error", (error as Error).message);
      this.emitter.emit("done", { exitCode: null });
    });
    this.child.on("close", (code) => {
      this.child = null;
      this.setState(code === 0 ? "done" : "error");
      this.emitter.emit("done", { exitCode: code });
    });
    this.setState("running", `claude code started (${this.label})`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      this.emitter.emit("output", { stream: "stdout", data: `${line}\n` });
      return;
    }
    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      this.remoteSessionId = event.session_id;
      return;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          this.push("assistant", block.text);
          this.emitter.emit("output", { stream: "stdout", data: `${block.text}\n` });
        }
        if (block.type === "tool_use") {
          const text = `${block.name ?? "tool"}(${JSON.stringify(block.input ?? {})})`;
          this.push("tool", text);
          this.emitter.emit("output", { stream: "tool", data: `${text}\n` });
        }
      }
      return;
    }
    if (event.type === "result") {
      if (event.result) {
        this.push("assistant", event.result);
        this.emitter.emit("output", { stream: "stdout", data: `${event.result}\n` });
      }
      return;
    }
    if (event.type === "control_request") {
      const request = event.control_request;
      const requestId = request?.id ?? "";
      const toolName = request?.request?.tool_name ?? "tool";
      const argsJson = JSON.stringify(request?.request?.tool_input ?? {});
      if (request?.request?.subtype === "can_use_tool" && requestId) {
        this.pendingControl.set(requestId, requestId);
        this.setState("waiting-tool");
        this.emitter.emit("toolRequest", { requestId, tool: toolName, argsJson, risk: "medium" });
      }
      return;
    }
    // Unknown event types fall through silently to stay forward compatible.
    this.stdout.push(line);
    if (this.stdout.length > 200) this.stdout.shift();
  }

  async prompt(text: string, attachments?: string[]): Promise<void> {
    if (!this.child) throw new Error("claude code process is not running");
    this.push("user", text);
    const content = [
      { type: "text", text },
      ...(attachments ?? []).map((path) => ({ type: "text", text: `@${path}` })),
    ];
    this.setState("running");
    this.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
  }

  async decide(requestId: string, allow: boolean, argsOverride?: string): Promise<boolean> {
    if (!this.child || !this.pendingControl.has(requestId)) return false;
    this.pendingControl.delete(requestId);
    const response = argsOverride
      ? { behavior: "allow", updatedInput: safeJson(argsOverride) }
      : allow
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Denied by remote controller" };
    this.child.stdin.write(`${JSON.stringify({
      type: "control_response",
      response: { request_id: requestId, response },
    })}\n`);
    this.setState("running");
    return true;
  }

  async cancel(): Promise<void> {
    this.child?.kill("SIGTERM");
    this.child = null;
    this.setState("canceled");
    this.emitter.emit("done", { exitCode: 130 });
  }

  on: AgentAdapter["on"] = (event, listener) => this.emitter.on(event, listener);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function claudeCodeAdapterFactory(defaults: Partial<ClaudeCodeOptions> = {}) {
  return (options: AdapterFactoryOptions) => new ClaudeCodeAdapter({ ...defaults, ...options });
}
