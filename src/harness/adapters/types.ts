import type {
  HarnessAgentType,
  HarnessOutputStream,
  HarnessSessionState,
  HarnessToolRisk,
  HarnessSnapshotEntry,
} from "../../shared/harness-protocol";

export type ToolRequestEvent = {
  requestId: string;
  tool: string;
  argsJson: string;
  risk: HarnessToolRisk;
};

export type AdapterEvents = {
  output: { stream: HarnessOutputStream; data: string };
  state: { state: HarnessSessionState; detail?: string };
  toolRequest: ToolRequestEvent;
  done: { exitCode?: number | null };
};

export type AdapterListener<K extends keyof AdapterEvents> = (event: AdapterEvents[K]) => void;

/** One running agent session on the host machine. */
export interface AgentAdapter {
  readonly agentType: HarnessAgentType;
  readonly workspace: string;
  readonly state: HarnessSessionState;
  /** Recent transcript for `session.snapshot` resync. */
  transcript(limit?: number): HarnessSnapshotEntry[];
  start(): Promise<void>;
  prompt(text: string, attachments?: string[]): Promise<void>;
  decide(requestId: string, allow: boolean, argsOverride?: string): Promise<boolean>;
  cancel(): Promise<void>;
  on<K extends keyof AdapterEvents>(event: K, listener: AdapterListener<K>): () => void;
}

export type AdapterFactoryOptions = {
  sessionId: string;
  workspace: string;
  label: string;
  /** Environment for spawned processes. */
  env?: Record<string, string>;
};

export type AdapterFactory = (options: AdapterFactoryOptions) => AgentAdapter;

/** Broadcast helper shared by adapter implementations. */
export class AdapterEmitter {
  private listeners: { [K in keyof AdapterEvents]: Set<AdapterListener<K>> } = {
    output: new Set(),
    state: new Set(),
    toolRequest: new Set(),
    done: new Set(),
  };

  on<K extends keyof AdapterEvents>(event: K, listener: AdapterListener<K>): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  emit<K extends keyof AdapterEvents>(event: K, payload: AdapterEvents[K]): void {
    for (const listener of this.listeners[event]) listener(payload);
  }
}
