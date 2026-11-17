import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextjsAdapter } from "../src/adapters/nextjs/index.js";
import { resolveNextjsInstall } from "../src/adapters/nextjs/install.js";
import type { GenerateContext } from "../src/generate/types.js";
import { generateWebMcp } from "../src/generate/webmcp.js";

const HOSTILE = [
  'Say "hi"',
  "C:\\path",
  "ends with backslash\\",
  "back`tick",
  "${x}",
  "</script><script>globalThis.pwned=1</script>",
  "<?php echo 'PWN'; ?>",
  "{{ x }}",
  '";globalThis.pwned=1;//',
  "a\u2028b",
  "a\u2029b",
];

const BASE = "https://example.com";

const fields = HOSTILE.map((h, i) => ({
  name: `f${i}`,
  type: "text",
  required: true,
  label: h,
}));
fields.push({
  name: "sel",
  type: "select",
  required: false,
  label: HOSTILE.join(" "),
  options: HOSTILE,
} as (typeof fields)[number]);

const ctx: GenerateContext = {
  pages: [
    {
      url: `${BASE}/page`,
      title: "Page",
      description: "",
      markdown: "",
      forms: [{ action: "/go", method: "POST", fields }],
    },
  ],
  rawPages: [],
  metadata: { baseUrl: BASE, wellKnown: {} },
  baseUrl: BASE,
};

const core = generateWebMcp(ctx);
const webmcpJs = core.find((f) => f.filename === "webmcp/webmcp.js")?.content ?? "";
const generated = await nextjsAdapter.generateIntegration(ctx, core);
const component = generated.find((f) => f.filename === "nextjs/components/WebMcpScript.tsx");

function renderChild(tsx: string): string {
  const out = ts.transpileModule(tsx, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment",
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  let captured: { props: Record<string, unknown>; children: unknown[] } | undefined;
  const sandbox: Record<string, unknown> = {
    exports: {},
    require: (id: string) => {
      if (id === "next/script") return { __esModule: true, default: "Script" };
      throw new Error(`unexpected require ${id}`);
    },
    h: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => {
      if (type === "Script") captured = { props: props ?? {}, children };
      return { type, props, children };
    },
    Fragment: "Fragment",
  };
  vm.createContext(sandbox);
  vm.runInContext(out.outputText, sandbox);
  (sandbox.exports as { default: () => unknown }).default();
  expect(captured).toBeDefined();
  const kids = captured?.children ?? [];
  expect(kids).toHaveLength(1);
  expect(typeof kids[0]).toBe("string");
  return kids[0] as string;
}

describe("Next.js WebMcpScript component (NX-8)", () => {
  it("is generated", () => {
    expect(webmcpJs).not.toBe("");
    expect(component).toBeDefined();
  });

  it("renders a child string equal to webmcp.js exactly", () => {
    expect(renderChild(component?.content ?? "")).toBe(webmcpJs);
  });

  it("keeps the use client directive first and a static usage comment", () => {
    const tsx = component?.content ?? "";
    expect(tsx.startsWith('"use client";')).toBe(true);
    const out = ts.transpileModule(tsx, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    }).outputText;
    expect(out.trimStart().startsWith('"use client";')).toBe(true);
    const comment = tsx.split("\n").find((l) => l.startsWith("// Add to your root layout"));
    expect(comment).toBeDefined();
    for (const h of HOSTILE) expect(comment).not.toContain(h);
    expect(comment).not.toContain(BASE);
  });

  it("documents the WebMCP step in the Next INSTALL.md", () => {
    const md = generated.find((f) => f.filename === "nextjs/INSTALL.md")?.content ?? "";
    expect(md).toContain("<WebMcpScript />");
  });

  it("registers the raw hostile strings and runs no injected code", () => {
    const child = renderChild(component?.content ?? "");
    const tools: {
      description: string;
      inputSchema: { properties: Record<string, { description: string; enum?: string[] }> };
    }[] = [];
    const sandbox: Record<string, unknown> = {
      document: { modelContext: { registerTool: (t: (typeof tools)[number]) => tools.push(t) } },
      CSS: { escape: (s: string) => s },
    };
    vm.createContext(sandbox);
    vm.runInContext(child, sandbox);
    expect(sandbox.pwned).toBeUndefined();
    expect(tools).toHaveLength(1);
    const props = tools[0].inputSchema.properties;
    HOSTILE.forEach((h, i) => {
      expect(props[`f${i}`].description).toBe(h);
    });
    expect(props.sel.description).toBe(HOSTILE.join(" "));
    expect(props.sel.enum).toEqual(HOSTILE);
  });
});

describe("Next.js install plan mounts WebMcpScript", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "w2agent-nextjs-webmcp-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function plan() {
    return resolveNextjsInstall([...core, ...generated], tempDir);
  }

  it("names the existing app/layout.js, not a nonexistent layout.tsx", () => {
    mkdirSync(join(tempDir, "app"), { recursive: true });
    writeFileSync(join(tempDir, "app", "layout.js"), "");
    const p = plan();
    const write = p.actions.find((a) => a.type === "write" && a.dest.endsWith("WebMcpScript.tsx"));
    expect(write).toBeDefined();
    const step = p.postInstallSteps.find((s) => s.includes("WebMcpScript"));
    expect(step).toContain(write?.dest);
    expect(step).toContain("<WebMcpScript />");
    expect(step).toContain(" in app/layout.js ");
    expect(step).not.toContain("layout.tsx");
  });

  it("names src/app/layout.tsx for a src/app project", () => {
    mkdirSync(join(tempDir, "src", "app"), { recursive: true });
    writeFileSync(join(tempDir, "src", "app", "layout.tsx"), "");
    const p = plan();
    const write = p.actions.find((a) => a.type === "write" && a.dest.endsWith("WebMcpScript.tsx"));
    const step = p.postInstallSteps.find((s) => s.includes("WebMcpScript"));
    expect(step).toContain(write?.dest);
    expect(step).toContain(" in src/app/layout.tsx ");
  });

  it("falls back to neutral wording naming the app dir when no layout exists", () => {
    mkdirSync(join(tempDir, "app"), { recursive: true });
    const step = plan().postInstallSteps.find((s) => s.includes("WebMcpScript"));
    expect(step).toContain("your root layout (app/layout.tsx)");
  });

  it("adds no mount step when the component is not written", () => {
    mkdirSync(join(tempDir, "app"), { recursive: true });
    const p = resolveNextjsInstall(
      core.filter((f) => !f.filename.startsWith("webmcp/")),
      tempDir,
    );
    expect(p.postInstallSteps.some((s) => s.includes("WebMcpScript"))).toBe(false);
  });
});
