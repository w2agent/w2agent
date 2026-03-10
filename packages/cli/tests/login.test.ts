import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHome = join(tmpdir(), `w2agent-login-test-${Date.now()}`);
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome, platform: actual.platform };
});

import { loadCredentials, saveCredentials } from "../src/auth.js";

describe("login command", () => {
  beforeEach(() => mkdirSync(testHome, { recursive: true }));
  afterEach(() => rmSync(testHome, { recursive: true, force: true }));

  it("--api-key validates w2a_ prefix", () => {
    const isValid = (key: string) => key.startsWith("w2a_") && key.length > 4;
    expect(isValid("w2a_abc123")).toBe(true);
    expect(isValid("sk_abc123")).toBe(false);
    expect(isValid("w2a_")).toBe(false);
    expect(isValid("")).toBe(false);
  });

  it("--api-key stores credentials", async () => {
    const key = "w2a_test_key_123";
    await saveCredentials(key);
    const creds = loadCredentials();
    expect(creds?.token).toBe(key);
  });

  it("stores email alongside token", async () => {
    await saveCredentials("w2a_abc", "user@example.com");
    const creds = loadCredentials();
    expect(creds?.token).toBe("w2a_abc");
    expect(creds?.email).toBe("user@example.com");
  });
});
