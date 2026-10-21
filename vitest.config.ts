import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    // The simulations run thousands of cases beside the ordinary tests: on a busy runner a 5 s test can be starved.
    testTimeout: 30_000,
  },
});
