import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { nextjsAdapter } from "../src/adapters/nextjs/index.js";
import {
  nextjsMiddlewareSource,
  nextjsWebhookRouteSource,
} from "../src/adapters/nextjs/templates.js";
import { nuxtAdapter } from "../src/adapters/nuxt/index.js";
import type { GenerateContext } from "../src/generate/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = "https://example.com";
const ctx: GenerateContext = {
  pages: [],
  rawPages: [],
  metadata: { baseUrl: BASE, wellKnown: {} },
  baseUrl: BASE,
};

const content = (files: { filename: string; content: string }[], name: string) => {
  const file = files.find((f) => f.filename === name)?.content;
  if (!file) throw new Error(`not emitted: ${name}`);
  return file;
};

const nextFiles = nextjsAdapter.generateIntegration(ctx, []);
const nuxtFiles = nuxtAdapter.generateIntegration(ctx, []);

const SOURCES: Record<string, string> = {
  "next middleware.ts": content(nextFiles, "nextjs/middleware.ts"),
  "next webhook route.ts": nextjsWebhookRouteSource("ts"),
  "next proxy.ts (Next 16)": nextjsMiddlewareSource({ lang: "ts", fn: "proxy" }),
  "nuxt emitted content-negotiation.ts": content(
    nuxtFiles,
    "nuxt/server/middleware/content-negotiation.ts",
  ),
  "@w2agent/nuxt content-negotiation.ts": readFileSync(
    join(here, "../../nuxt/src/runtime/server/middleware/content-negotiation.ts"),
    "utf8",
  ),
};

function typecheck(source: string): string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: ["node"],
  };
  const virtual = join(here, "__virtual__", "generated.ts");
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, lang, ...rest) =>
    name === virtual
      ? ts.createSourceFile(name, source, lang)
      : getSourceFile.call(host, name, lang, ...rest);
  host.fileExists = (name) => name === virtual || fileExists.call(host, name);
  host.readFile = (name) => (name === virtual ? source : readFile.call(host, name));
  const program = ts.createProgram([virtual], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === virtual)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("generated middleware type-checks under strict settings", () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    it(`${name} (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes)`, () => {
      expect(typecheck(source)).toEqual([]);
    });
  }
});
