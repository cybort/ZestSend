import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import type { HarnessPermissionMode } from "../shared/harness-protocol";

export type ShellPolicy = {
  permission: HarnessPermissionMode;
  /** Every command runs with cwd confined to this directory. */
  sandboxRoot: string;
  /** If non-empty, the command must match one of these patterns. */
  allowPatterns?: string[];
  /** Commands matching any of these patterns are always rejected. */
  denyPatterns?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export const DEFAULT_DENY_PATTERNS = [
  String.raw`\brm\s+-[a-z]*r[a-z]*f\s+/`,
  String.raw`\bmkfs\b`,
  String.raw`\bdd\s+if=`,
  String.raw`\bshutdown\b`,
  String.raw`\breboot\b`,
  String.raw`:\(\)\s*\{`,
  String.raw`\bchmod\s+-R\s+777\s+/`,
  String.raw`\bcurl\b[^|]*\|\s*(ba)?sh\b`,
  String.raw`\bwget\b[^|]*\|\s*(ba)?sh\b`,
];

export type ShellCheck = { ok: true } | { ok: false; reason: string };

export function checkCommand(command: string, policy: ShellPolicy): ShellCheck {
  if (policy.permission !== "full") {
    return { ok: false, reason: "Shell access requires the `full` permission mode." };
  }
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "Empty command." };
  if (trimmed.length > 4_000) return { ok: false, reason: "Command too long." };
  for (const pattern of policy.denyPatterns ?? DEFAULT_DENY_PATTERNS) {
    if (new RegExp(pattern, "i").test(trimmed)) return { ok: false, reason: "Command matches a denied pattern." };
  }
  const allowPatterns = policy.allowPatterns ?? [];
  if (allowPatterns.length > 0 && !allowPatterns.some((pattern) => new RegExp(pattern, "i").test(trimmed))) {
    return { ok: false, reason: "Command is not on the allow list." };
  }
  return { ok: true };
}

/** Resolve a caller-supplied cwd inside the sandbox; anything else falls back to the root. */
export function resolveSandboxedCwd(sandboxRoot: string, cwd?: string): string {
  const root = resolve(sandboxRoot);
  if (!cwd) return root;
  const candidate = resolve(root, cwd);
  return candidate === root || candidate.startsWith(root + sep) ? candidate : root;
}

export type ShellRunEvent = {
  stream: "stdout" | "stderr";
  data: string;
  done?: boolean;
};

export type ShellRunHandle = {
  shellId: string;
  done: Promise<{ exitCode: number | null; timedOut: boolean }>;
  kill(): void;
};

export function runShellCommand(
  shellId: string,
  command: string,
  policy: ShellPolicy,
  onChunk: (event: ShellRunEvent) => void,
  cwd?: string,
  timeoutMs?: number,
): ShellRunHandle {
  const child = spawn(command, {
    shell: true,
    cwd: resolveSandboxedCwd(policy.sandboxRoot, cwd),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...process.env },
  });
  const limit = policy.maxOutputBytes ?? 2 * 1024 * 1024;
  let emitted = 0;
  let timedOut = false;

  const forward = (stream: "stdout" | "stderr") => (buffer: Buffer) => {
    if (emitted >= limit) return;
    emitted += buffer.byteLength;
    onChunk({ stream, data: buffer.toString("utf8") });
  };
  child.stdout?.on("data", forward("stdout"));
  child.stderr?.on("data", forward("stderr"));

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs ?? policy.timeoutMs ?? 30_000);

  const done = new Promise<{ exitCode: number | null; timedOut: boolean }>((resolveDone) => {
    child.on("error", () => {
      clearTimeout(timeout);
      onChunk({ stream: "stderr", data: "Failed to start command.", done: true });
      resolveDone({ exitCode: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      onChunk({ stream: "stdout", data: "", done: true });
      resolveDone({ exitCode: code, timedOut });
    });
  });

  return {
    shellId,
    done,
    kill: () => {
      clearTimeout(timeout);
      child.kill("SIGKILL");
    },
  };
}
