import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  HarnessSessionState,
  HarnessSnapshotEntry,
} from "../../shared/harness-protocol";
import { AdapterEmitter, type AdapterFactoryOptions, type AgentAdapter } from "./types";
import type { SpawnFn } from "./claude-code";

export type CopilotCliOptions = AdapterFactoryOptions & {
  /** Path to the `copilot` binary. */
  binary?: string;
  /** Tool permission flags, e.g. ["--allow-tool", "shell"]. */
  toolFlags?: string[];
  spawnFn?: SpawnFn;
};

/**
 * Copilot CLI adapter. The CLI exposes prompt/output in headless mode but its
 * tool permissions are configured at launch, so v1 forwards prompts and streams
 * output while tool gating stays host-side (`toolFlags`).
 */
export class CopilotCliAdapter implements AgentAdapter {
  readonly agentType = "copilot-cli" as const;
  readonly workspace: string;
  private readonly label: string;
  private readonly options: CopilotCliOptions;
  private readonly emitter = new AdapterEmitter();
  private readonly entries: HarnessSnapshotEntry[] = [];
  private stateValue: HarnessSessionState = "starting";
  private child: ChildProcessWithoutNullStreams | null = null;
  private runToken = 0;

  constructor(options: CopilotCliOptions) {
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
    this.setState("running", `copilot cli ready (${this.label})`);
  }

  async prompt(text: string, attachments?: string[]): Promise<void> {
    const spawnFn = this.options.spawnFn ?? ((command, args, options) => nodeSpawn(command, args, options) as ChildProcessWithoutNullStreams);
    const token = ++this.runToken;
    this.push("user", text);
    const promptText = attachments?.length
      ? `${text}\n\n${attachments.map((path) => `@${path}`).join(" ")}`
      : text;
    const args = ["-p", promptText, ...(this.options.toolFlags ?? [])];
    this.setState("running");
    this.child = spawnFn(this.options.binary ?? "copilot", args, {
      cwd: this.workspace,
      env: { ...process.env, ...this.options.env } as Record<string, string>,
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (token !== this.runToken) return;
      const data = chunk.toString("utf8");
      this.push("assistant", data);
      this.emitter.emit("output", { stream: "stdout", data });
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (token !== this.runToken) return;
      this.emitter.emit("output", { stream: "stderr", data: chunk.toString("utf8") });
    });
    this.child.on("error", (error) => {
      if (token !== this.runToken) return;
      this.setState("error", (error as Error).message);
      this.emitter.emit("done", { exitCode: null });
    });
    this.child.on("close", (code) => {
      if (token !== this.runToken) return;
      this.child = null;
      this.setState(code === 0 ? "done" : "error");
      this.emitter.emit("done", { exitCode: code });
    });
  }

  async decide(): Promise<boolean> {
    // Tool gating is launch-time for Copilot CLI; nothing to decide at runtime.
    return false;
  }

  async cancel(): Promise<void> {
    this.runToken += 1;
    this.child?.kill("SIGTERM");
    this.child = null;
    this.setState("canceled");
    this.emitter.emit("done", { exitCode: 130 });
  }

  on: AgentAdapter["on"] = (event, listener) => this.emitter.on(event, listener);
}

export function copilotCliAdapterFactory(defaults: Partial<CopilotCliOptions> = {}) {
  return (options: AdapterFactoryOptions) => new CopilotCliAdapter({ ...defaults, ...options });
}
