import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration.test.ts"],
    testTimeout: 720_000,
    hookTimeout: 720_000,
  },
});
