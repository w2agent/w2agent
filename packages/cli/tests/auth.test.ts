import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempBase = join(tmpdir(), `w2agent-test-${process.pid}`);
const tempHome = join(tempBase, "home");
const expectedConfigPath = join(tempHome, ".w2agent", "config.json");

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => tempHome };
});

const { clearCredentials, getAuthHeaders, getConfigPath, loadCredentials, saveCredentials } =
  await import("../src/auth.js");

describe("auth credential module", () => {
  beforeEach(() => {
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempBase)) {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });

  describe("getConfigPath", () => {
    it("returns path under home directory", () => {
      expect(getConfigPath()).toBe(expectedConfigPath);
    });
  });

  describe("loadCredentials", () => {
    it("returns null when config file does not exist", () => {
      expect(loadCredentials()).toBeNull();
    });

    it("returns null for malformed JSON", () => {
      mkdirSync(join(tempHome, ".w2agent"), { recursive: true });
      writeFileSync(expectedConfigPath, "not-json");
      expect(loadCredentials()).toBeNull();
    });

    it("returns null when token field is missing", () => {
      mkdirSync(join(tempHome, ".w2agent"), { recursive: true });
      writeFileSync(expectedConfigPath, JSON.stringify({ email: "test@example.com" }));
      expect(loadCredentials()).toBeNull();
    });

    it("returns credentials when file is valid", async () => {
      await saveCredentials("w2a_abc123", "user@example.com");
      const creds = loadCredentials();
      expect(creds).not.toBeNull();
      expect(creds?.token).toBe("w2a_abc123");
      expect(creds?.email).toBe("user@example.com");
    });

    it("returns credentials without email when email is omitted", async () => {
      await saveCredentials("w2a_abc123");
      const creds = loadCredentials();
      expect(creds?.token).toBe("w2a_abc123");
      expect(creds?.email).toBeUndefined();
    });
  });

  describe("saveCredentials", () => {
    it("writes a readable JSON config file", async () => {
      await saveCredentials("w2a_testtoken", "test@example.com");
      expect(existsSync(expectedConfigPath)).toBe(true);
      const creds = loadCredentials();
      expect(creds?.token).toBe("w2a_testtoken");
      expect(creds?.email).toBe("test@example.com");
    });

    it("includes a created timestamp", async () => {
      const before = new Date().toISOString();
      await saveCredentials("w2a_testtoken");
      const after = new Date().toISOString();
      const raw = JSON.parse(readFileSync(expectedConfigPath, "utf-8"));
      expect(raw.created >= before).toBe(true);
      expect(raw.created <= after).toBe(true);
    });

    it("overwrites existing credentials", async () => {
      await saveCredentials("w2a_old");
      await saveCredentials("w2a_new", "new@example.com");
      const creds = loadCredentials();
      expect(creds?.token).toBe("w2a_new");
      expect(creds?.email).toBe("new@example.com");
    });

    it("creates the config directory if it does not exist", async () => {
      await saveCredentials("w2a_testtoken");
      expect(existsSync(join(tempHome, ".w2agent"))).toBe(true);
    });
  });

  describe("clearCredentials", () => {
    it("deletes the config file", async () => {
      await saveCredentials("w2a_abc");
      expect(existsSync(expectedConfigPath)).toBe(true);
      clearCredentials();
      expect(existsSync(expectedConfigPath)).toBe(false);
    });

    it("does not throw when file does not exist", () => {
      expect(() => clearCredentials()).not.toThrow();
    });
  });

  describe("getAuthHeaders", () => {
    it("returns empty object when not authenticated", () => {
      expect(getAuthHeaders()).toEqual({});
    });

    it("returns Authorization header when authenticated", async () => {
      await saveCredentials("w2a_mytoken");
      expect(getAuthHeaders()).toEqual({ Authorization: "Bearer w2a_mytoken" });
    });

    it("returns empty object after logout", async () => {
      await saveCredentials("w2a_mytoken");
      clearCredentials();
      expect(getAuthHeaders()).toEqual({});
    });
  });
});
