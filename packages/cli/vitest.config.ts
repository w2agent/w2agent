import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Port 1 on loopback is closed: a test that forgets to set its own API URL
    // gets a connection error instead of reaching the hosted service.
    env: { W2AGENT_API_URL: "http://127.0.0.1:1" },
  },
});
