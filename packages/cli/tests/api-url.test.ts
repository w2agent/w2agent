import { describe, expect, it } from "vitest";
import { parseApiUrl } from "../src/auth.js";

function accepted(raw: string | undefined): string {
  const r = parseApiUrl(raw);
  if (!r.ok) throw new Error(`expected accepted, got: ${r.message}`);
  return r.url;
}

function refused(raw: string): string {
  const r = parseApiUrl(raw);
  if (r.ok) throw new Error(`expected refused, got: ${r.url}`);
  return r.message;
}

describe("parseApiUrl", () => {
  it("defaults when unset or empty", () => {
    expect(accepted(undefined)).toBe("https://w2agent.dev");
    expect(accepted("")).toBe("https://w2agent.dev");
  });

  it("allows https on any host and keeps a path prefix without trailing slashes", () => {
    expect(accepted("https://example.test/prefix/")).toBe("https://example.test/prefix");
    expect(accepted("https://example.test/")).toBe("https://example.test");
    expect(accepted("https://example.test//")).toBe("https://example.test");
  });

  it("allows http on loopback hostnames, normalised by the URL parser", () => {
    expect(accepted("http://localhost:3000")).toBe("http://localhost:3000");
    expect(accepted("http://LOCALHOST:3000/")).toBe("http://localhost:3000");
    expect(accepted("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(accepted("http://127.1")).toBe("http://127.0.0.1");
    expect(accepted("http://127.255.0.9:1")).toBe("http://127.255.0.9:1");
    expect(accepted("http://[::1]:8787")).toBe("http://[::1]:8787");
  });

  it("refuses http on a non-loopback host, including look-alikes", () => {
    for (const raw of [
      "http://api.evil.test",
      "http://127.0.0.1.evil.test",
      "http://localhost.evil.test",
      "http://127.0.0.1@evil.test",
      "http://localhost@evil.test:80",
      "http://0.0.0.0",
      "http://128.0.0.1",
      "http://[::2]",
      "http://example.test:127",
    ]) {
      refused(raw);
    }
  });

  it("refuses other schemes and unparseable values", () => {
    for (const raw of [
      "ftp://127.0.0.1",
      "ws://127.0.0.1",
      "file:///tmp/x",
      "javascript:alert(1)",
      "not a url",
      "//example.test",
      "127.0.0.1:8787",
    ]) {
      refused(raw);
    }
  });

  it("names the variable and never echoes userinfo", () => {
    const message = refused("http://user:hunter2secret@evil.test/path");
    expect(message).toContain("W2AGENT_API_URL");
    expect(message).toContain("evil.test");
    expect(message).not.toContain("hunter2secret");
    expect(refused("not a url")).toContain("W2AGENT_API_URL");
  });
});
