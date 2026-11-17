import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted) ---

const testHome = join(tmpdir(), `w2agent-deploy-test-${Date.now()}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

// --- Imports (after mocks) ---

import { saveCredentials } from "../src/auth.js";
import { registerDeployCommand } from "../src/commands/deploy.js";

// --- Helpers ---

function buildProgram() {
  const program = new Command();
  program.exitOverride(); // commander errors throw instead of process.exit
  registerDeployCommand(program);
  return program;
}

interface ResultOverrides {
  slug?: string;
  agentEndpoint?: string;
  pagesIndexed?: number;
  totalPagesFound?: number;
  tools?: Array<{ name: string }>;
  webhookUrl?: string;
  webhookToken?: string;
  isRedeploy?: boolean;
}

function makeResultData(overrides: ResultOverrides = {}) {
  return {
    slug: "test-site",
    agentEndpoint: "https://agent.w2agent.dev/test-site",
    pagesIndexed: 10,
    tools: [{ name: "search" }],
    webhookUrl: "https://w2agent.dev/webhooks/test-site",
    webhookToken: "tok_abc123",
    isRedeploy: false,
    ...overrides,
  };
}

function makeSseResponse(events: Array<{ type: string; data: unknown }>): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function makeRawResponse(chunks: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function makeErrorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status });
}

// --- Tests ---

describe("deploy command", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mkdirSync(testHome, { recursive: true });
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // --- Auth header construction ---

  describe("auth header construction", () => {
    it("uses --api-key flag over stored credentials", async () => {
      await saveCredentials("w2a_stored");
      const mockFetch = vi
        .fn()
        .mockResolvedValue(makeSseResponse([{ type: "result", data: makeResultData() }]));
      vi.stubGlobal("fetch", mockFetch);

      await buildProgram().parseAsync([
        "node",
        "w2agent",
        "deploy",
        "https://example.com",
        "--api-key",
        "w2a_flagkey",
      ]);

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer w2a_flagkey");
    });

    it("uses stored credentials when no --api-key flag", async () => {
      await saveCredentials("w2a_storedtoken");
      const mockFetch = vi
        .fn()
        .mockResolvedValue(makeSseResponse([{ type: "result", data: makeResultData() }]));
      vi.stubGlobal("fetch", mockFetch);

      await buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]);

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer w2a_storedtoken");
    });

    it("warns and deploys anonymously when no auth available", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(makeSseResponse([{ type: "result", data: makeResultData() }])),
      );

      await buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]);

      const allLog = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allLog).toContain("Not logged in");
    });
  });

  // --- SSE parsing ---

  describe("SSE parsing", () => {
    it("processes progress events and continues to result", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeSseResponse([
            { type: "progress", data: "Crawling pages..." },
            { type: "progress", data: "Indexing content..." },
            { type: "result", data: makeResultData() },
          ]),
        ),
      );

      await buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]);

      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("exits 1 on SSE error event", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(makeSseResponse([{ type: "error", data: "Site is unavailable" }])),
      );

      await expect(
        buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
      const allError = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allError).toContain("Site is unavailable");
    });

    it("exits 1 when stream ends without result event", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeSseResponse([{ type: "progress", data: "Working..." }]), // no result
        ),
      );

      await expect(
        buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("ignores malformed data lines and parses valid lines", async () => {
      const validResult = makeResultData({ slug: "ok-site" });
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: not-json\n\ndata: ${JSON.stringify({ type: "result", data: validResult })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

      await buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]);

      const allLog = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allLog).toContain("ok-site");
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe("SSE framing variants (DEP-5)", () => {
    const result = (extra: object = {}) =>
      JSON.stringify({ type: "result", data: makeResultData(extra) });
    const logged = () => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const errored = () => errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const deploy = () =>
      buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]);

    it("processes a final event with no trailing newline", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeRawResponse([`data: ${result()}`])));
      await deploy();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logged()).toContain("https://agent.w2agent.dev/test-site");
      expect(logged()).not.toContain("undefined");
    });

    it("accepts data: without a space after the colon", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeRawResponse([`data:${result()}\n\n`])));
      await deploy();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logged()).toContain("test-site");
    });

    it("accepts CRLF line endings, split across chunks", async () => {
      const text = `data: ${JSON.stringify({ type: "progress", data: "x" })}\r\n\r\ndata: ${result()}\r\n\r\n`;
      const cut = text.indexOf("\r\n", 10) + 1;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(makeRawResponse([text.slice(0, cut), text.slice(cut)])),
      );
      await deploy();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logged()).toContain("https://agent.w2agent.dev/test-site");
    });

    it("prints data.message for an object error event", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            makeSseResponse([{ type: "error", data: { message: "Crawl blocked", code: 7 } }]),
          ),
      );
      await expect(deploy()).rejects.toThrow("process.exit");
      expect(errored()).toContain("Crawl blocked");
      expect(errored()).not.toContain('"message"');
      expect(errored()).not.toContain("[object Object]");
    });

    it("prints the JSON for an object error event without a message", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(makeSseResponse([{ type: "error", data: { code: 7 } }])),
      );
      await expect(deploy()).rejects.toThrow("process.exit");
      expect(errored()).toContain('{"code":7}');
    });

    it("a result without webhook fields still prints", async () => {
      const { webhookToken: _t, webhookUrl: _u, ...bare } = makeResultData();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(makeSseResponse([{ type: "result", data: bare }])),
      );
      await deploy();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logged()).toContain("test-site");
      expect(logged()).not.toContain("Webhook");
    });

    it("treats a result without tools as empty", async () => {
      const { tools: _tools, ...noTools } = makeResultData();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(makeSseResponse([{ type: "result", data: noTools }])),
      );
      await deploy();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(logged()).toContain("test-site");
      expect(logged()).not.toContain("Tools");
    });
  });

  // --- Result formatting ---

  describe("result formatting", () => {
    it("displays slug and agent endpoint", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeSseResponse([
            {
              type: "result",
              data: makeResultData({
                slug: "my-site",
                agentEndpoint: "https://agent.w2agent.dev/my-site",
              }),
            },
          ]),
        ),
      );

      await buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]);

      const allLog = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allLog).toContain("my-site");
      expect(allLog).toContain("https://agent.w2agent.dev/my-site");
    });

    it("shows tool names", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeSseResponse([
            {
              type: "result",
              data: makeResultData({ tools: [{ name: "search" }, { name: "get_page" }] }),
            },
          ]),
        ),
      );

      await buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]);

      const allLog = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allLog).toContain("search");
      expect(allLog).toContain("get_page");
    });

    it("masks webhook token by default", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            makeSseResponse([
              { type: "result", data: makeResultData({ webhookToken: "w2wh_abc123xyz" }) },
            ]),
          ),
      );

      await buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]);

      const allLog = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allLog).toContain("w2wh_****");
      expect(allLog).not.toContain("abc123xyz");
    });

    it("shows full token with --show-token flag", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            makeSseResponse([
              { type: "result", data: makeResultData({ webhookToken: "w2wh_abc123xyz" }) },
            ]),
          ),
      );

      await buildProgram().parseAsync([
        "node",
        "w2agent",
        "deploy",
        "https://example.com",
        "--show-token",
      ]);

      const allLog = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allLog).toContain("w2wh_abc123xyz");
    });

    it("shows 'Redeployed' label for redeployments", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            makeSseResponse([{ type: "result", data: makeResultData({ isRedeploy: true }) }]),
          ),
      );

      await buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]);

      const allLog = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allLog).toContain("Re-agentized");
    });
  });

  // --- HTTP error handling ---

  describe("HTTP error handling", () => {
    it("401 with --api-key says the key was rejected, not to log in", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeErrorResponse(401, "Unauthorized")));

      await expect(
        buildProgram().parseAsync([
          "node",
          "w2agent",
          "deploy",
          "https://example.com",
          "--api-key",
          "w2a_bad",
        ]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
      const allError = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allError).toContain("API key passed with --api-key was rejected");
      expect(allError).not.toContain("w2agent login");
    });

    it("401 with saved credentials says to run login --force", async () => {
      saveCredentials("w2a_saved");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeErrorResponse(401, "Unauthorized")));

      await expect(
        buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
      const allError = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allError).toContain("saved credentials were rejected");
      expect(allError).toContain("w2agent login --force");
    });

    it("401 when anonymous keeps the login advice", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeErrorResponse(401, "Unauthorized")));

      await expect(
        buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]),
      ).rejects.toThrow("process.exit");

      const allError = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allError).toContain("Run `w2agent login` to authenticate");
    });

    it("handles 403 with server error message", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(makeErrorResponse(403, "Already owned by another account")),
      );

      await expect(
        buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
      const allError = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allError).toContain("Already owned by another account");
    });

    it("handles 400 with invalid request message", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(makeErrorResponse(400, "Invalid URL format")),
      );

      await expect(
        buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
      const allError = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(allError).toContain("Invalid URL format");
    });

    it("handles network errors", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      await expect(
        buildProgram().parseAsync(["node", "w2agent", "deploy", "https://example.com"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
