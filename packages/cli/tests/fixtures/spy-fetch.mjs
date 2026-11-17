import { appendFileSync } from "node:fs";

// Records every fetch and refuses to send it, so a test can assert that none was attempted.
globalThis.fetch = (input, init) => {
  const href = typeof input === "string" ? input : String(input?.url ?? input);
  appendFileSync(process.env.SPY_LOG, `${init?.method ?? "GET"} ${href}\n`);
  return Promise.reject(new Error("fetch blocked by test spy"));
};
