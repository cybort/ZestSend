import { defineConfig } from "vitest/config";

/**
 * Daemon-side tests run in the plain Node environment: they exercise
 * `node:fs` / `node:child_process` modules that workerd does not provide.
 */
export default defineConfig({
  test: {
    include: ["test/harness-daemon.test.ts"],
    environment: "node",
    maxWorkers: 1,
    fileParallelism: false,
    isolate: false,
  },
});
