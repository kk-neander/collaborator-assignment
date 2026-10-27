import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "harness/*/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
