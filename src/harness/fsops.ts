import { lstatSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { HARNESS_FILE_INLINE_MAX, type HarnessPermissionMode } from "../shared/harness-protocol";

export type FsPolicy = {
  permission: HarnessPermissionMode;
  sandboxRoot: string;
};

export type FsEntry = { name: string; kind: "file" | "directory"; size: number };

function sandboxedPath(root: string, path: string): string | null {
  const base = resolve(root);
  const candidate = resolve(base, path || ".");
  return candidate === base || candidate.startsWith(base + sep) ? candidate : null;
}

export function listDirectory(policy: FsPolicy, path: string): { ok: true; entries: FsEntry[] } | { ok: false; error: string } {
  const target = sandboxedPath(policy.sandboxRoot, path);
  if (!target) return { ok: false, error: "Path escapes the sandbox." };
  try {
    const entries = readdirSync(target, { withFileTypes: true }).slice(0, 500).map((entry) => {
      let size = 0;
      try { size = lstatSync(resolve(target, entry.name)).size; } catch { /* keep 0 */ }
      return {
        name: entry.name,
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        size,
      };
    });
    return { ok: true, entries };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export function readFile(policy: FsPolicy, path: string): { ok: true; data: string } | { ok: false; error: string } {
  const target = sandboxedPath(policy.sandboxRoot, path);
  if (!target) return { ok: false, error: "Path escapes the sandbox." };
  try {
    const buffer = readFileSync(target);
    if (buffer.byteLength > HARNESS_FILE_INLINE_MAX) return { ok: false, error: "File exceeds the inline limit; use bulk transfer." };
    return { ok: true, data: buffer.toString("base64") };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export function writeFile(policy: FsPolicy, path: string, data: string, overwrite = true): { ok: true } | { ok: false; error: string } {
  if (policy.permission !== "full") return { ok: false, error: "File writes require the `full` permission mode." };
  const target = sandboxedPath(policy.sandboxRoot, path);
  if (!target) return { ok: false, error: "Path escapes the sandbox." };
  if (data.length > HARNESS_FILE_INLINE_MAX * 1.4) return { ok: false, error: "Payload exceeds the inline limit." };
  if (!overwrite && existsSync(target)) return { ok: false, error: "File already exists." };
  try {
    writeFileSync(target, Buffer.from(data, "base64"));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
