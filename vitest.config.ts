import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // Daemon tests need real Node primitives (child_process); they run under
    // vitest.harness.config.ts instead of the workerd pool.
    exclude: ["test/harness-daemon.test.ts", "test/shared-playback.test.ts", "**/node_modules/**"],
    maxWorkers: 1,
    fileParallelism: false,
    isolate: false,
  },
});
