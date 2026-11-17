import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchedPage } from "../src/audit/types.js";
import type { EcommerceArtifacts } from "../src/generate/ecommerce.js";
import { htmlToMarkdown } from "../src/generate/html-to-markdown.js";
import type { LocalBusinessArtifacts } from "../src/generate/local-business.js";
import { generateMcpServer } from "../src/generate/mcp-server.js";
import type { GenerateContext } from "../src/generate/types.js";
import { VARIANTS, type Variant } from "./helpers/mcp-boot.js";
import { CORE_DIR } from "./helpers/mcp-harness.js";

const SITE = "https://example.com";
const API_HOST = "https://api.example.net";
const TSC = join(CORE_DIR, "node_modules/.bin/tsc");

// Stands in for the real @vercel/node package, which is not a repo dependency.
// The shapes mirror the real declarations; the E2E type-checks against the real package.
const VERCEL_NODE_STUB = `import type { IncomingMessage, ServerResponse } from "node:http";
export type VercelRequestCookies = { [key: string]: string };
export type VercelRequestQuery = { [key: string]: string | string[] };
export type VercelRequestBody = any;
export type VercelRequest = IncomingMessage & {
  query: VercelRequestQuery;
  cookies: VercelRequestCookies;
  body: VercelRequestBody;
};
export type VercelResponse = ServerResponse & {
  send: (body: any) => VercelResponse;
  json: (jsonBody: any) => VercelResponse;
  status: (statusCode: number) => VercelResponse;
  redirect: (statusOrUrl: string | number, url?: string) => VercelResponse;
};
`;

const searchLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  url: `${SITE}/`,
  potentialAction: {
    "@type": "SearchAction",
    target: `${SITE}/find?q={search_term_string}`,
    "query-input": "required name=search_term_string",
  },
};

const faqHtml = `<!doctype html><html><head><title>FAQ</title><script type="application/ld+json">${JSON.stringify(
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Do you ship?",
        acceptedAnswer: { "@type": "Answer", text: "Yes." },
      },
    ],
  },
)}</script></head><body><main><h1>FAQ</h1></main></body></html>`;

function rawPage(url: string, html: string): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 1 };
}

function fullCtx(): GenerateContext {
  const contactHtml = `<!doctype html><html><head><title>Contact</title></head><body><main><h1>Contact</h1><form action="https://forms.example.net/contact-submit" method="post"><label for="n">Name</label><input id="n" name="name" type="text" required></form></main></body></html>`;
  const homeHtml = `<!doctype html><html><head><title>Home</title><script type="application/ld+json">${JSON.stringify(searchLd)}</script></head><body><main><h1>Home</h1></main></body></html>`;
  return {
    pages: [
      htmlToMarkdown(homeHtml, `${SITE}/`),
      htmlToMarkdown(contactHtml, `${SITE}/contact`),
      { url: `${SITE}/faq`, title: "FAQ", description: "Questions", markdown: "FAQ" },
    ],
    rawPages: [
      rawPage(`${SITE}/`, homeHtml),
      rawPage(`${SITE}/faq`, faqHtml),
      rawPage(`${SITE}/contact`, contactHtml),
    ],
    metadata: {
      baseUrl: SITE,
      wellKnown: {},
      openapi: {
        specUrl: `${API_HOST}/openapi.json`,
        version: "3.0.0",
        serverUrl: API_HOST,
        endpoints: [
          {
            path: "/pets/{petId}/{ids}",
            method: "get",
            operationId: "getPet",
            summary: "Get a pet",
            parameters: [
              { name: "petId", in: "path", required: true, type: "string" },
              { name: "verbose", in: "query", required: false, type: "boolean" },
              { name: "tags", in: "query", required: false, type: "array" },
              { name: "filter", in: "query", required: true, type: "object" },
              { name: "ids", in: "path", required: true, type: "array" },
            ],
          },
          {
            path: "/pets",
            method: "post",
            operationId: "createPet",
            summary: "Create a pet",
            parameters: [{ name: "dryRun", in: "query", required: false, type: "boolean" }],
            requestBody: {
              contentType: "application/json",
              required: true,
              properties: {
                name: { type: "string" },
                age: { type: "number" },
                vaccinated: { type: "boolean" },
                toys: { type: "array" },
                traits: { type: "object" },
                nick: { type: ["string", "null"] as unknown as string },
              },
            },
          },
        ],
      },
    },
    baseUrl: SITE,
    allowedOffOriginHosts: ["forms.example.net", "api.example.net"],
  } as GenerateContext;
}

function minimalCtx(): GenerateContext {
  const homeHtml = `<!doctype html><html><head><title>Home</title></head><body><main><h1>Home</h1></main></body></html>`;
  return {
    pages: [htmlToMarkdown(homeHtml, `${SITE}/`)],
    rawPages: [rawPage(`${SITE}/`, homeHtml)],
    metadata: { baseUrl: SITE, wellKnown: {} },
    baseUrl: SITE,
  } as GenerateContext;
}

const ecommerce: EcommerceArtifacts = {
  products: [
    {
      productId: "p_1",
      name: "Blue Widget",
      url: `${SITE}/widget`,
      price: 5,
      availability: "InStock",
      source: "json-ld",
    },
  ],
};

const localBusiness: LocalBusinessArtifacts = {
  business: {
    name: "Corner Cafe",
    type: "CafeOrCoffeeShop",
    url: SITE,
    hours: [{ days: ["Mon", "Tue"], opens: "08:00", closes: "17:00" }],
    menu: `${SITE}/menu`,
    services: `${SITE}/services`,
    bookingUrl: `${SITE}/book`,
    source: "json-ld",
  },
};

let tmpRoot = "";

beforeAll(() => {
  tmpRoot = mkdtempSync(join(CORE_DIR, ".tmp-mcp-tsc-"));
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function emit(variant: Variant, name: string, full: boolean): string {
  const root = join(tmpRoot, name);
  const files = full
    ? generateMcpServer(
        fullCtx(),
        variant === "express" ? undefined : variant,
        ecommerce,
        localBusiness,
      )
    : generateMcpServer(minimalCtx(), variant === "express" ? undefined : variant);
  for (const f of files) {
    const target = join(root, f.filename);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
  }
  const dir = join(root, "mcp-server");
  const stub = join(dir, "node_modules/@vercel/node");
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, "index.d.ts"), VERCEL_NODE_STUB);
  writeFileSync(join(stub, "package.json"), '{"name":"@vercel/node","types":"index.d.ts"}');
  return dir;
}

function tsc(dir: string, project = "tsconfig.json"): void {
  try {
    execFileSync(TSC, ["--noEmit", "-p", join(dir, project)], { stdio: "pipe" });
  } catch (e) {
    const err = e as { stdout?: Buffer };
    throw new Error(`tsc failed in ${dir}:\n${err.stdout?.toString() ?? String(e)}`);
  }
}

describe.each(VARIANTS)("emitted %s code type-checks under the generated tsconfig", (variant) => {
  it("with every feature enabled", () => {
    tsc(emit(variant, `${variant}-full`, true));
  }, 120000);

  it("with a minimal site", () => {
    tsc(emit(variant, `${variant}-min`, false));
  }, 120000);
});

describe("generated Worker package.json", () => {
  it("has no workers-types dependency and a SDK range that ships the web-standard transport", () => {
    const files = generateMcpServer(minimalCtx(), "cf");
    const pkg = JSON.parse(
      files.find((f) => f.filename === "mcp-server/package.json")?.content ?? "",
    );
    expect(pkg.devDependencies).not.toHaveProperty("@cloudflare/workers-types");
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBe("^1.25.0");
  });
});

describe("emitted Worker code does not depend on Node typings", () => {
  it("type-checks with no ambient @types packages", () => {
    const dir = emit("cf", "cf-notypes", true);
    writeFileSync(
      join(dir, "tsconfig.notypes.json"),
      JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { types: [] } }),
    );
    tsc(dir, "tsconfig.notypes.json");
  }, 120000);
});
