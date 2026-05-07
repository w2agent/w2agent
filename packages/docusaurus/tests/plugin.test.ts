import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import * as fs from "node:fs";
import w2agentPlugin from "../src/index";

const mockFs = vi.mocked(fs);

function makeContext(siteDir = "/site") {
  return {
    siteDir,
    siteConfig: { url: "https://example.com", title: "My Docs", tagline: "Great docs" },
  };
}

function makePostBuildProps(outDir = "/out") {
  return {
    siteConfig: { url: "https://example.com", title: "My Docs", tagline: "Great docs" },
    outDir,
  };
}

function setupDocsMd(content: string) {
  mockFs.existsSync.mockImplementation((p) => {
    const s = String(p);
    return s.endsWith("/docs") || s.endsWith("intro.md");
  });
  mockFs.readdirSync.mockReturnValue([{ name: "intro.md", isDirectory: () => false }] as never);
  mockFs.readFileSync.mockReturnValue(content as never);
  mockFs.mkdirSync.mockReturnValue(undefined);
  mockFs.writeFileSync.mockReturnValue(undefined);
  mockFs.copyFileSync.mockReturnValue(undefined);
}

describe("postBuild — llms.txt generation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("generates llms.txt from docs frontmatter title", async () => {
    setupDocsMd("---\ntitle: Introduction\n---\nHello world paragraph here.");
    const plugin = w2agentPlugin(makeContext());
    await plugin.postBuild(makePostBuildProps());
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("/out/llms.txt"),
      expect.stringContaining("# My Docs"),
    );
    const written = vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("- [Introduction](");
  });

  it("uses sidebar_label when title is absent from frontmatter", async () => {
    setupDocsMd("---\nsidebar_label: Quick Start\n---\nBody text");
    const plugin = w2agentPlugin(makeContext());
    await plugin.postBuild(makePostBuildProps());
    const written = vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("- [Quick Start](");
  });

  it("falls back to first H1 heading when no frontmatter title", async () => {
    setupDocsMd("---\n---\n# Getting Started\n\nBody text");
    const plugin = w2agentPlugin(makeContext());
    await plugin.postBuild(makePostBuildProps());
    const written = vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("- [Getting Started](");
  });

  it("skips file with no title at all", async () => {
    setupDocsMd("---\n---\nJust a body paragraph.");
    const plugin = w2agentPlugin(makeContext());
    await plugin.postBuild(makePostBuildProps());
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("groups files into sections by subdirectory", async () => {
    mockFs.existsSync.mockImplementation((p) => String(p).endsWith("/docs"));
    mockFs.readdirSync
      .mockReturnValueOnce([{ name: "api", isDirectory: () => true }] as never)
      .mockReturnValueOnce([{ name: "config.md", isDirectory: () => false }] as never);
    mockFs.readFileSync.mockReturnValue("---\ntitle: Config\n---\nDesc" as never);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.copyFileSync.mockReturnValue(undefined);

    const plugin = w2agentPlugin(makeContext());
    await plugin.postBuild(makePostBuildProps());
    const written = vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain("## Api\n");
  });

  it("does not generate llms.txt when docsDir does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.copyFileSync.mockReturnValue(undefined);

    const plugin = w2agentPlugin(makeContext());
    await plugin.postBuild(makePostBuildProps());
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("falls back to static/llms.txt when docs dir missing", async () => {
    mockFs.existsSync.mockImplementation((p) => String(p).endsWith("static/llms.txt"));
    mockFs.readFileSync.mockReturnValue("# Fallback content" as never);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.copyFileSync.mockReturnValue(undefined);

    const plugin = w2agentPlugin(makeContext());
    await plugin.postBuild(makePostBuildProps());
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("llms.txt"),
      "# Fallback content",
    );
  });

  it("respects custom docsDir option", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.copyFileSync.mockReturnValue(undefined);

    const plugin = w2agentPlugin(makeContext(), { docsDir: "content" });
    await plugin.postBuild(makePostBuildProps());
    expect(mockFs.existsSync).toHaveBeenCalledWith(expect.stringContaining("/content"));
    const docsCalls = vi
      .mocked(mockFs.existsSync)
      .mock.calls.filter((c) => String(c[0]).endsWith("/docs"));
    expect(docsCalls).toHaveLength(0);
  });
});

describe("postBuild — agent-card.json", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("copies agent-card.json to .well-known/ when source exists", async () => {
    mockFs.existsSync.mockImplementation((p) => String(p).includes(".well-known/agent-card.json"));
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.copyFileSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);

    const plugin = w2agentPlugin(makeContext());
    await plugin.postBuild(makePostBuildProps());
    expect(mockFs.mkdirSync).toHaveBeenCalledWith("/out/.well-known", { recursive: true });
    expect(mockFs.copyFileSync).toHaveBeenCalledWith(
      expect.stringContaining("static/.well-known/agent-card.json"),
      expect.stringContaining(".well-known/agent-card.json"),
    );
  });

  it("skips agent-card copy when source does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);

    const plugin = w2agentPlugin(makeContext());
    await plugin.postBuild(makePostBuildProps());
    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
  });
});

describe("postBuild — webhook", () => {
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

    const plugin = w2agentPlugin(makeContext());
    await plugin.postBuild(makePostBuildProps());
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hook.example.com",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not fire webhook when W2AGENT_WEBHOOK_URL is not set", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const plugin = w2agentPlugin(makeContext());
    await plugin.postBuild(makePostBuildProps());
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
