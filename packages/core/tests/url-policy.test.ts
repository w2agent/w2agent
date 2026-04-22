import { describe, expect, it } from "vitest";
import { isOriginAllowed, isPrivateHost } from "../src/shared/url-policy.js";

describe("isPrivateHost", () => {
  it.each([
    ["127.0.0.1"],
    ["127.255.255.254"],
    ["0.0.0.0"],
    ["localhost"],
    ["169.254.169.254"], // AWS/GCP metadata
    ["10.0.0.1"],
    ["10.255.255.254"],
    ["172.16.0.1"],
    ["172.31.255.254"],
    ["192.168.1.1"],
    ["::1"],
    ["fc00::1"], // IPv6 ULA
    ["fd00::1"],
    ["fe80::1"], // IPv6 link-local
  ])("blocks %s", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each([
    ["example.com"],
    ["api.example.com"],
    ["8.8.8.8"],
    ["172.15.0.1"], // just outside RFC1918
    ["172.32.0.1"], // just outside RFC1918
    ["2606:4700::1"], // cloudflare IPv6
  ])("allows %s", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  const baseOrigin = "https://example.com";

  it("allows same-origin URL", () => {
    expect(isOriginAllowed("https://example.com/api", baseOrigin)).toBe(true);
  });

  it("rejects different-origin URL by default", () => {
    expect(isOriginAllowed("https://api.evil.example/x", baseOrigin)).toBe(false);
  });

  it("allows off-origin URL when host is in allowlist", () => {
    expect(
      isOriginAllowed("https://api.partner.com/x", baseOrigin, ["api.partner.com"]),
    ).toBe(true);
  });

  it("rejects off-origin allowlisted host that resolves to a private IP literal", () => {
    expect(
      isOriginAllowed("http://169.254.169.254/latest/meta-data/", baseOrigin, [
        "169.254.169.254",
      ]),
    ).toBe(false);
  });

  it("rejects off-origin hostname that is a private literal even if allowlisted", () => {
    expect(
      isOriginAllowed("http://localhost:8080/x", baseOrigin, ["localhost"]),
    ).toBe(false);
  });

  it("rejects malformed URL", () => {
    expect(isOriginAllowed("not a url", baseOrigin)).toBe(false);
  });

  it("rejects non-http(s) protocols", () => {
    expect(isOriginAllowed("file:///etc/passwd", baseOrigin, ["localhost"])).toBe(false);
    expect(isOriginAllowed("gopher://example.com/", baseOrigin)).toBe(false);
  });
});
