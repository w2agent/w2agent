import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JsonMode } from "../src/agent/output.js";

const home = mkdtempSync(join(tmpdir(), "w2agent-browser-test-"));
process.env.HOME = home;

const { runBrowserLogin } = await import("../src/commands/login.js");

function fakeJson() {
  const docs: unknown[] = [];
  const mode: JsonMode = {
    emit: async (doc) => {
      docs.push(doc);
    },
    restore: () => {},
  };
  return { mode, docs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runBrowserLogin", () => {
  it("emits one document on success and never emits a later timeout", async () => {
    const { mode, docs } = fakeJson();
    const exit = vi.fn();
    const timeoutMs = 400;
    const done = runBrowserLogin({
      json: mode,
      timeoutMs,
      exit,
      open: (authUrl) => {
        const u = new URL(authUrl);
        void fetch(
          `http://127.0.0.1:${u.searchParams.get("port")}/callback?token=w2a_tok&state=${u.searchParams.get("state")}`,
        );
      },
    });
    await done;
    await sleep(timeoutMs * 2);
    expect(docs).toEqual([{ ok: true, outcome: "authenticated" }]);
    expect(exit).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(home, ".w2agent", "config.json"), "utf-8")).token).toBe(
      "w2a_tok",
    );
  });

  it("clears the timeout timer on success so it cannot keep the process alive", async () => {
    const { mode } = fakeJson();
    const handles: unknown[] = [];
    const realSet = globalThis.setTimeout;
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const h = realSet(fn, ms);
      if (ms === 60_000) handles.push(h);
      return h;
    }) as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      await runBrowserLogin({
        json: mode,
        timeoutMs: 60_000,
        exit: vi.fn(),
        open: (authUrl) => {
          const u = new URL(authUrl);
          void fetch(
            `http://127.0.0.1:${u.searchParams.get("port")}/callback?token=w2a_tok&state=${u.searchParams.get("state")}`,
          );
        },
      });
      expect(handles).toHaveLength(1);
      expect(clearSpy).toHaveBeenCalledWith(handles[0]);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("emits a timeout envelope and exits 1 when no callback arrives", async () => {
    const { mode, docs } = fakeJson();
    const exit = vi.fn();
    await runBrowserLogin({ json: mode, timeoutMs: 100, exit, open: () => {} });
    expect(exit).toHaveBeenCalledWith(1);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ ok: false, error: { reason: "timeout" } });
  });
});

describe("runBrowserLogin when credentials cannot be saved", () => {
  it("reports an operational envelope instead of throwing", async () => {
    const blocked = join(mkdtempSync(join(tmpdir(), "w2agent-browser-blocked-")), "file");
    writeFileSync(blocked, "not a directory");
    const savedHome = process.env.HOME;
    process.env.HOME = blocked;
    try {
      const { mode, docs } = fakeJson();
      const exit = vi.fn();
      let status = 0;
      await runBrowserLogin({
        json: mode,
        timeoutMs: 5000,
        exit,
        open: (authUrl) => {
          const u = new URL(authUrl);
          void fetch(
            `http://127.0.0.1:${u.searchParams.get("port")}/callback?token=w2a_tok&state=${u.searchParams.get("state")}`,
          ).then((r) => {
            status = r.status;
          });
        },
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ ok: false, error: { reason: "unknown_failure" } });
      await sleep(50);
      expect(status).toBe(500);
    } finally {
      process.env.HOME = savedHome;
    }
  });
});
