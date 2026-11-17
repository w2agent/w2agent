import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GeneratedFile, InstallPlan } from "w2agent-core";
import {
  applyArgv,
  dryRunArgv,
  mapPlanChanges,
  rewriteOrigin,
} from "../src/commands/integrate-support.js";

function file(filename: string, content: string): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content, "utf-8") };
}

describe("mapPlanChanges", () => {
  it("maps write to create or modify by whether the destination exists, and carries every action type", () => {
    const dir = mkdtempSync(join(tmpdir(), "w2agent-plan-"));
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "llms.txt"), "old");
    const plan: InstallPlan = {
      platform: "nextjs",
      warnings: [],
      postInstallSteps: [],
      actions: [
        { type: "write", dest: "app/new.ts", content: "x" },
        { type: "write", dest: "public/llms.txt", content: "x" },
        { type: "skip", dest: "a.txt", reason: "already there" },
        { type: "manual", dest: "b.txt" },
        { type: "delete", dest: "public/llms.txt" },
      ],
    };
    const changes = mapPlanChanges(plan, dir);
    expect(changes.map((c) => c.action)).toEqual(["create", "modify", "skip", "manual", "delete"]);
    expect(changes.map((c) => c.path)).toEqual([
      "app/new.ts",
      "public/llms.txt",
      "a.txt",
      "b.txt",
      "public/llms.txt",
    ]);
    expect(changes[2].reason).toBe("already there");
    for (const c of changes) expect(typeof c.reason).toBe("string");
    expect(changes.every((c) => c.reason.length > 0)).toBe(true);
  });
});

describe("applyArgv / dryRunArgv", () => {
  it("swaps --dry-run for --install and keeps --json", () => {
    expect(applyArgv(["w2agent", "integrate", "https://a.example", "--dry-run", "--json"])).toEqual(
      ["w2agent", "integrate", "https://a.example", "--install", "--json"],
    );
  });

  it("does not duplicate --install", () => {
    expect(applyArgv(["w2agent", "integrate", "u", "--install", "--dry-run"])).toEqual([
      "w2agent",
      "integrate",
      "u",
      "--install",
    ]);
  });

  it("builds the dry-run form of a generate command without --output", () => {
    expect(dryRunArgv(["w2agent", "integrate", "u", "-o", "out", "--json"])).toEqual([
      "w2agent",
      "integrate",
      "u",
      "--json",
      "--dry-run",
    ]);
    expect(dryRunArgv(["w2agent", "integrate", "u", "--output=out"])).toEqual([
      "w2agent",
      "integrate",
      "u",
      "--dry-run",
    ]);
  });
});

describe("rewriteOrigin", () => {
  const site = "https://acme.example";

  it("replaces the crawl origin and recomputes size", () => {
    const f = file("llms.txt", "see http://localhost:3000/docs and http://localhost:3000");
    const { files, warnings } = rewriteOrigin([f], "http://localhost:3000", site);
    expect(files[0].content).toBe("see https://acme.example/docs and https://acme.example");
    expect(files[0].size).toBe(Buffer.byteLength(files[0].content, "utf-8"));
    expect(files[0].size).not.toBe(f.size);
    expect(warnings).toEqual([]);
  });

  it("respects the origin boundary", () => {
    const content = [
      "http://localhost:30001/a",
      "http://localhost:3000.evil.com/a",
      "http://localhost:3000@evil.com/a",
      "http://localhost:3000-x/a",
      "xhttp://localhost:3000/a",
      "mylocalhost:3000 and 127.0.0.10 and localhost.evil.com",
    ].join("\n");
    const { files } = rewriteOrigin([file("a", content)], "http://localhost:3000", site);
    expect(files[0].content).toContain("http://localhost:30001/a");
    expect(files[0].content).toContain("http://localhost:3000.evil.com/a");
    expect(files[0].content).toContain("http://localhost:3000@evil.com/a");
    expect(files[0].content).toContain("http://localhost:3000-x/a");
    expect(files[0].content).toContain("mylocalhost:3000 and 127.0.0.10 and localhost.evil.com");
  });

  it("rewrites the bare crawl hostname and host:port, with boundaries", () => {
    const { files, warnings } = rewriteOrigin(
      [
        file(
          "a",
          "# 127.0.0.1\nhost 127.0.0.1:3000 ip 127.0.0.10 and 127.0.0.1.evil.com and x127.0.0.1",
        ),
      ],
      "http://127.0.0.1:3000",
      site,
    );
    expect(files[0].content).toBe(
      "# acme.example\nhost acme.example ip 127.0.0.10 and 127.0.0.1.evil.com and x127.0.0.1",
    );
    expect(warnings).toEqual([]);
  });

  it("warns when the bare crawl hostname remains with another port", () => {
    const { warnings } = rewriteOrigin(
      [file("a.txt", "http://127.0.0.1:9999/x"), file("b.txt", "clean")],
      "http://127.0.0.1:3000",
      site,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("127.0.0.1");
    expect(warnings[0]).toContain("a.txt");
    expect(warnings[0]).not.toContain("b.txt");
  });

  it("treats other loopback names on the crawl port as aliases", () => {
    const { files, warnings } = rewriteOrigin(
      [
        file(
          "a",
          "http://localhost:3000/x http://[::1]:3000/y http://127.0.0.1:3000/z http://localhost:4000/q",
        ),
      ],
      "http://127.0.0.1:3000",
      site,
    );
    expect(files[0].content).toBe(
      "https://acme.example/x https://acme.example/y https://acme.example/z http://localhost:4000/q",
    );
    expect(warnings).toEqual([]);
    const other = rewriteOrigin(
      [file("a", "http://localhost:3000/x")],
      "http://example.test:3000",
      site,
    );
    expect(other.files[0].content).toBe("http://localhost:3000/x");
  });

  it("rewrites the percent-encoded origin", () => {
    const { files, warnings } = rewriteOrigin(
      [file("a", "?u=http%3A%2F%2Flocalhost%3A3000%2Fx")],
      "http://localhost:3000",
      site,
    );
    expect(files[0].content).toBe("?u=https%3A%2F%2Facme.example%2Fx");
    expect(warnings).toEqual([]);
  });

  it("matches at sentence end and before a path, query, quote or slash", () => {
    const { files } = rewriteOrigin(
      [
        file(
          "a",
          'go to http://localhost:3000. Also "http://localhost:3000"?x=1 (http://localhost:3000)',
        ),
      ],
      "http://localhost:3000",
      site,
    );
    expect(files[0].content).toBe(
      'go to https://acme.example. Also "https://acme.example"?x=1 (https://acme.example)',
    );
  });

  it("handles the JSON-escaped form", () => {
    const { files } = rewriteOrigin(
      [file("c.json", '{"url":"http:\\/\\/localhost:3000\\/mcp"}')],
      "http://localhost:3000",
      site,
    );
    expect(files[0].content).toBe('{"url":"https:\\/\\/acme.example\\/mcp"}');
    expect(() => JSON.parse(files[0].content)).not.toThrow();
  });

  it("treats a default port and no port as the same origin, but not other ports", () => {
    const content = "http://localhost/a http://localhost:80/b http://localhost:8080/c";
    const { files, warnings } = rewriteOrigin([file("a", content)], "http://localhost", site);
    expect(files[0].content).toBe(
      "https://acme.example/a https://acme.example/b http://localhost:8080/c",
    );
    expect(warnings).toHaveLength(1);
    const again = rewriteOrigin([file("a", content)], "http://localhost:80", site);
    expect(again.files[0].content).toBe(files[0].content);
  });

  it("is case-insensitive on the host", () => {
    const { files } = rewriteOrigin(
      [file("a", "HTTP://LOCALHOST:3000/x")],
      "http://localhost:3000",
      site,
    );
    expect(files[0].content).toBe("https://acme.example/x");
  });

  it("does not warn for names that merely share a prefix or suffix with the crawl host", () => {
    const { warnings } = rewriteOrigin(
      [file("a", "localhost:3000.evil.com and mylocalhost:3000 and localhost.evil.com")],
      "http://localhost:3000",
      site,
    );
    expect(warnings).toEqual([]);
  });

  it("rewrites a bare default-port crawl host", () => {
    const { files, warnings } = rewriteOrigin(
      [file("a", "mail me at user@staging.acme-dev.test\nhost staging.acme-dev.test")],
      "http://staging.acme-dev.test",
      site,
    );
    expect(files[0].content).toBe("mail me at user@acme.example\nhost acme.example");
    expect(warnings).toEqual([]);
  });

  it("is a no-op when the origins are equal and skips the residue check for the same host", () => {
    const same = rewriteOrigin(
      [file("a", "https://acme.example/x")],
      "https://acme.example/page",
      site,
    );
    expect(same.warnings).toEqual([]);
    const scheme = rewriteOrigin([file("a", "http://acme.example/x")], "http://acme.example", site);
    expect(scheme.files[0].content).toBe("https://acme.example/x");
    expect(scheme.warnings).toEqual([]);
  });

  it("does not mutate its input", () => {
    const f = file("a", "http://localhost:3000");
    rewriteOrigin([f], "http://localhost:3000", site);
    expect(f.content).toBe("http://localhost:3000");
  });
});
