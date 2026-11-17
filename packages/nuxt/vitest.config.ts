import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "#imports": fileURLToPath(new URL("./tests/stubs/imports.ts", import.meta.url)),
    },
  },
});
