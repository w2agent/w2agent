import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: ["tests/integration.test.ts", "tests/debug_temp.test.ts", "node_modules"],
  },
});
