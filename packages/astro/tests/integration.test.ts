import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import * as fs from "node:fs";
import w2agentAstro from "../src/index";

const mockFs = vi.mocked(fs);

function makeDir(path: string) {
  return new URL(`file://${path}/`);
}

function getHook(integration: ReturnType<typeof w2agentAstro>, hookName: string) {
  return (integration.hooks as Record<string, unknown>)[hookName] as (
    ...args: unknown[]
  ) => unknown;
}

function setupContentMd(content: string) {
  mockFs.existsSync.mockImplementation((p) => {
    const s = String(p);
    return s.endsWith("/src/content") || s.endsWith("intro.md");
  });
  mockFs.readdirSync.mockReturnValue([{ name: "intro.md", isDirectory: () => false }] as never);
  mockFs.readFileSync.mockReturnValue(content as never);
  mockFs.mkdirSync.mockReturnValue(undefined);
  mockFs.writeFileSync.mockReturnValue(undefined);
  mockFs.copyFileSync.mockReturnValue(undefined);
}

describe("astro:build:done — llms.txt generation", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("generates llms.txt from content frontmatter title", async () => {
    setupContentMd("---\ntitle: Introduction\n---\nHello world.");
    const integration = w2agentAstro();
    await getHook(integration, "astro:build:done")({ dir: makeDir("/out") });
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("/out/llms.txt"),
      expect.stringContaining("# AI Content Index"),
    );
    const written = vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("- [Introduction](");
  });

  it("falls back to first H1 when no frontmatter title", async () => {
    setupContentMd("---\n---\n# Getting Started\n\nBody.");
    const integration = w2agentAstro();
    await getHook(integration, "astro:build:done")({ dir: makeDir("/out") });
    const written = vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("- [Getting Started](");
  });

  it("skips file with no title at all", async () => {
    setupContentMd("---\n---\nJust body text.");
    const integration = w2agentAstro();
    await getHook(integration, "astro:build:done")({ dir: makeDir("/out") });
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not generate llms.txt when contentDir does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.copyFileSync.mockReturnValue(undefined);
    const integration = w2agentAstro();
    await getHook(integration, "astro:build:done")({ dir: makeDir("/out") });
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("astro:build:done — agent-card.json", () => {
  beforeEach(() => vi.resetAllMocks());

  it("copies agent-card.json to .well-known/ when source exists", async () => {
    mockFs.existsSync.mockImplementation((p) =>
      String(p).includes("public/.well-known/agent-card.json"),
    );
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.copyFileSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    const integration = w2agentAstro();
    await getHook(integration, "astro:build:done")({ dir: makeDir("/out") });
    expect(mockFs.mkdirSync).toHaveBeenCalledWith("/out/.well-known", { recursive: true });
    expect(mockFs.copyFileSync).toHaveBeenCalledWith(
      expect.stringContaining("public/.well-known/agent-card.json"),
      expect.stringContaining(".well-known/agent-card.json"),
    );
  });

  it("skips agent-card copy when source does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    const integration = w2agentAstro();
    await getHook(integration, "astro:build:done")({ dir: makeDir("/out") });
    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
  });
});

describe("astro:build:done — webhook", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.copyFileSync.mockReturnValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("fires webhook when W2AGENT_WEBHOOK_URL is set", async () => {
    vi.stubEnv("W2AGENT_WEBHOOK_URL", "https://hook.example.com");
    const mockFetch = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", mockFetch);
    const integration = w2agentAstro();
    await getHook(integration, "astro:build:done")({ dir: makeDir("/out") });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hook.example.com",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not fire webhook when W2AGENT_WEBHOOK_URL is not set", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const integration = w2agentAstro();
    await getHook(integration, "astro:build:done")({ dir: makeDir("/out") });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("astro:config:setup — SSR route injection", () => {
  it("injects routes when output is server", () => {
    const injectRoute = vi.fn();
    const integration = w2agentAstro();
    getHook(
      integration,
      "astro:config:setup",
    )({
      config: { output: "server", root: new URL("file:///site/"), site: "https://example.com" },
      injectRoute,
    });
    expect(injectRoute).toHaveBeenCalledWith(expect.objectContaining({ pattern: "/llms.txt" }));
    expect(injectRoute).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: "/.well-known/agent-card.json" }),
    );
    expect(injectRoute).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: "/api/w2agent-webhook" }),
    );
  });

  it("does not inject routes when output is static", () => {
    const injectRoute = vi.fn();
    const integration = w2agentAstro();
    getHook(
      integration,
      "astro:config:setup",
    )({
      config: { output: "static", root: new URL("file:///site/") },
      injectRoute,
    });
    expect(injectRoute).not.toHaveBeenCalled();
  });

  it("skips webhook route when webhookEnabled is false", () => {
    const injectRoute = vi.fn();
    const integration = w2agentAstro({ webhookEnabled: false });
    getHook(
      integration,
      "astro:config:setup",
    )({
      config: { output: "server", root: new URL("file:///site/") },
      injectRoute,
    });
    const patterns = injectRoute.mock.calls.map((c) => c[0].pattern);
    expect(patterns).not.toContain("/api/w2agent-webhook");
  });
});
