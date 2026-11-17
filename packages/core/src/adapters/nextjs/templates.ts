import type { GeneratedFile } from "../../generate/types.js";
import { homeVariantSource, type SourceLang } from "../shared/accept-negotiation.js";

export type { SourceLang };

// The one segment config the routes carry. The resolver removes this exact
// text when the project turns on cacheComponents (Next rejects `revalidate`
// there), so the template and the removal cannot drift.
export const ROUTE_REVALIDATE_SEGMENT =
  "// ISR: regenerate every hour\nexport const revalidate = 3600;\n\n";

// The file name and exported function Next reads: `middleware` before Next 16, `proxy` from 16.
export type NextjsEdgeFn = "middleware" | "proxy";

export function nextjsMiddlewareSource({ lang, fn }: { lang: SourceLang; fn: NextjsEdgeFn }) {
  const ts = lang === "ts";
  return `/* eslint-disable */
import { ${ts ? "NextRequest, " : ""}NextResponse } from "next/server";

${homeVariantSource(lang)}

export function ${fn}(request${ts ? ": NextRequest" : ""}) {
  if (request.nextUrl.pathname !== "/") return NextResponse.next();

  // Content negotiation: markdown gets /index.md, plain text gets /llms.txt, everything else the page
  const variant = homeVariant(request.headers.get("accept"));
  let response = NextResponse.next();
  if (variant !== "html") {
    // clone() keeps basePath and the query string
    const target = request.nextUrl.clone();
    target.pathname = variant === "markdown" ? "/index.md" : "/llms.txt";
    response = NextResponse.rewrite(target);
  }
  // "/" depends on Accept in every branch: caches must not mix the variants
  response.headers.append("Vary", "Accept");
  return response;
}

export const config = {
  matcher: ["/"],
};
`;
}

export const WEBHOOK_ROUTE_PATH = "nextjs/app/api/w2agent-mcp-webhook/route.ts";

export function nextjsWebhookRouteSource(lang: SourceLang) {
  const ts = lang === "ts";
  return `import { NextResponse } from "next/server";

/**
 * w2agent MCP Webhook — Next.js Integration
 *
 * Place at: app/api/w2agent-mcp-webhook/route.${ts ? "ts" : "js"}
 * Triggers a re-crawl when content changes.
 *
 * Requires W2AGENT_INBOUND_TOKEN; callers must present it as a Bearer token.
 * Without this check the route is a confused deputy — unauthenticated callers
 * would otherwise receive authenticated upstream webhook calls for free.
 */

const WEBHOOK_URL = process.env.W2AGENT_WEBHOOK_URL || "https://w2agent.dev/api/agent/webhook/YOUR_SLUG";
const WEBHOOK_TOKEN = process.env.W2AGENT_WEBHOOK_TOKEN || "YOUR_WEBHOOK_TOKEN";

export async function POST(request${ts ? ": Request" : ""}) {
  const expected = process.env.W2AGENT_INBOUND_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "W2AGENT_INBOUND_TOKEN not configured" },
      { status: 401 },
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    // Notify w2agent MCP server of content change
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Bearer \${WEBHOOK_TOKEN}\`,
      },
      body: JSON.stringify({ trigger: "nextjs", ...body }),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: ${ts ? "(err as Error).message" : "err.message"} }, { status: 500 });
  }
}
`;
}

export function generateNextjsIntegration(
  llmsTxtContent: string,
  llmsFullTxtContent: string,
  agentCardContent: string | undefined,
  siteUrl: string,
  homeMarkdownContent?: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  const middlewareTs = nextjsMiddlewareSource({ lang: "ts", fn: "middleware" });

  // Dynamic route handler for /llms.txt — ISR, regenerates every hour
  const llmsTxtRoute = `/* eslint-disable */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

${ROUTE_REVALIDATE_SEGMENT}export async function GET() {
  // Read from generated file (updated by build script or CI)
  const filePath = path.join(process.cwd(), ".w2agent", "llms.txt");
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    return new NextResponse(content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  }

  // Fallback — generate minimal llms.txt from page metadata
  // Customize this to read from your CMS, database, or file system
  const content = generateLlmsTxtFromPages();
  return new NextResponse(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}

function generateLlmsTxtFromPages() {
  // TODO: Replace with your actual page data source
  // Examples:
  //   - Read from a CMS API
  //   - Scan app/ directory for page.tsx files
  //   - Query your database
  const host = "${siteUrl}".replace(/^https?:\\/\\//, "");
  return "# " + host + "\\n\\n> AI-ready content index\\n\\n" +
    "## Pages\\n\\n- [Home](${siteUrl}): Main page\\n";
}
`;

  // Markdown twin of the homepage: .w2agent/index.md (the home page's own content), else the llms.txt content
  const indexMdRoute = `/* eslint-disable */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

${ROUTE_REVALIDATE_SEGMENT}export async function GET() {
  // The home page as markdown, else the same content as /llms.txt, else a minimal fallback
  const dir = path.join(process.cwd(), ".w2agent");
  const homePath = path.join(dir, "index.md");
  const llmsPath = path.join(dir, "llms.txt");
  const host = "${siteUrl}".replace(/^https?:\\/\\//, "");
  const content = fs.existsSync(homePath)
    ? fs.readFileSync(homePath, "utf-8")
    : fs.existsSync(llmsPath)
      ? fs.readFileSync(llmsPath, "utf-8")
      : "# " + host + "\\n\\n> AI-ready content index\\n\\n" +
        "## Pages\\n\\n- [Home](${siteUrl}): Main page\\n";
  return new NextResponse(content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Vary": "Accept",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
`;

  // Dynamic route handler for llms-full.txt
  const llmsFullTxtRoute = `/* eslint-disable */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

${ROUTE_REVALIDATE_SEGMENT}export async function GET() {
  const filePath = path.join(process.cwd(), ".w2agent", "llms-full.txt");
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    return new NextResponse(content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  }

  return new NextResponse("# No content generated yet\\n\\nRun: npx --no -- w2agent generate ${siteUrl} --format llms-txt,full --no-platform --output ./.w2agent/\\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
`;

  const agentCardRoute = `/* eslint-disable */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

${ROUTE_REVALIDATE_SEGMENT}export async function GET() {
  const filePath = path.join(process.cwd(), ".w2agent", "agent-card.json");
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    return NextResponse.json(JSON.parse(content), {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  }

  // No A2A agent card published — 404 so agents and audits see the card as absent
  return new NextResponse("Not Found", { status: 404 });
}
`;

  // Build script for CI/CD regeneration — uses execFileSync to avoid shell injection
  const buildScript = `#!/usr/bin/env node
/**
 * w2agent build script — run during CI/CD or as a prebuild hook
 *
 * Usage:
 *   node w2agent-build.mjs
 *
 * Or add to package.json:
 *   "scripts": { "prebuild": "node w2agent-build.mjs" }
 *
 * It must run before the build: the routes are prerendered during next build,
 * so a postbuild refresh would not be served.
 *
 * This crawls your live site and refreshes llms.txt, llms-full.txt and index.md
 * (the home page as markdown), so the next build serves what the live site showed
 * (the previous deploy).
 *
 * Requires the w2agent CLI installed in this project. It is not published on npm
 * yet: build it from the w2agent repo, then run
 *   npm install -D <path-to-w2agent>/packages/cli
 * (npx runs with --no, so it never downloads a package.)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const SITE_URL = process.env.SITE_URL || ${JSON.stringify(siteUrl)};

console.log("[w2agent] Regenerating AI content for " + SITE_URL + "...");

try {
  execFileSync(
    "npx",
    ["--no", "--", "w2agent", "generate", SITE_URL, "--format", "llms-txt,full,markdown", "--no-platform", "--output", "./.w2agent/"],
    { stdio: "inherit" }
  );
  // The markdown format writes one file per page with front matter. Keep only the start page (the home page, also under a base path), without front matter.
  const pagesDir = "./.w2agent/markdown";
  const pathOf = (u) => {
    try {
      return new URL(u).pathname.replace(/\\/+$/, "") || "/";
    } catch {
      return "";
    }
  };
  // generate adds https:// to a scheme-less URL; match the start page the same way.
  const startPath = pathOf(SITE_URL.startsWith("http://") || SITE_URL.startsWith("https://") ? SITE_URL : "https://" + SITE_URL);
  const files = fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir) : [];
  for (const name of files) {
    const raw = fs.readFileSync(pagesDir + "/" + name, "utf-8");
    const match = raw.match(/^---\\n([\\s\\S]*?)\\n---\\n+/);
    const field = (key) => {
      const line = match && match[1].match(new RegExp("^" + key + ": (.*)$", "m"));
      try {
        return line ? JSON.parse(line[1]) : "";
      } catch {
        return "";
      }
    };
    if (!startPath || pathOf(field("url")) !== startPath) continue;
    const title = field("title");
    let body = (match ? raw.slice(match[0].length) : raw).trim();
    if (!body) break;
    if (title && !/^# /.test(body)) body = "# " + title + "\\n\\n" + body;
    fs.writeFileSync("./.w2agent/index.md", body + "\\n");
    break;
  }
  fs.rmSync(pagesDir, { recursive: true, force: true });
  console.log("[w2agent] Done. Files written to .w2agent/");
} catch (err) {
  // Non-fatal: the route handlers have fallback logic
  console.warn(
    "[w2agent] Generation failed: " + (err && err.message ? err.message : String(err)) + "\\n" +
    "[w2agent] Either the w2agent CLI is not installed in this project (it is not published on npm yet: " +
    "build it from the w2agent repo, then run npm install -D <path-to-w2agent>/packages/cli) " +
    "or the crawl of " + SITE_URL + " failed. Route handlers will use fallback content."
  );
}
`;

  const installMd = `# w2agent Next.js Integration — Installation

## Architecture

This integration uses **dynamic route handlers** that read \`.w2agent/llms.txt\`, \`.w2agent/llms-full.txt\` and \`.w2agent/index.md\` (the home page as markdown).
Content freshness depends on the build script (step 3), not on the routes alone.

\`\`\`
Request for /llms.txt
  -> Route handler reads .w2agent/llms.txt (seed, or refreshed by the build script)
  -> Returns with Cache-Control (routes revalidate hourly with ISR, which re-reads the same deployed file: new content arrives with the next build)
  -> If file missing, generates minimal fallback from page data
\`\`\`

\`npx w2agent integrate <url> --install\` applies the conventions below for you.
These steps are for copying the files by hand.

## Setup

### 1. Copy route handlers and middleware
\`\`\`bash
cp -r nextjs/app/ your-app/app/
cp nextjs/middleware.ts your-app/
\`\`\`

- **\`src/app\` projects**: put the routes in \`src/app/\`, the middleware in \`src/\` and the component in \`src/components/\`.
- **Next.js 16**: the file is \`proxy.ts\` and the function is \`export function proxy\`. Rename \`middleware.ts\` and its function when copying by hand. Next.js 15 and earlier keep \`middleware.ts\`.
- **JavaScript projects (no \`tsconfig.json\`)**: \`--install\` writes \`.js\` and \`.jsx\` files. By hand, rename each \`route.ts\` to \`route.js\` and the component to \`.jsx\`, except \`app/api/w2agent-mcp-webhook/route.ts\` (only present when an MCP server was generated) and \`middleware.ts\`: both have type annotations, so use the \`.js\` files that \`--install\` writes.
- **\`cacheComponents: true\`**: remove \`export const revalidate\` from the routes (Next.js rejects it there). \`--install\` does this. The routes then have no segment config and are prerendered at build.
- **\`output: "export"\`**: middleware does not run in a static export, so skip it. \`/llms.txt\`, \`/llms-full.txt\` and \`/index.md\` are exported as static files. There is no Accept negotiation on \`/\`. Keep \`export const revalidate\` on the routes: a static export requires it. If \`cacheComponents\` is also on, Next.js rejects it, so the routes need a manual change in that combination.

### 2. Copy seed files (immediate content)
\`\`\`bash
cp -r nextjs/.w2agent/ your-app/.w2agent/
\`\`\`

The first deploy serves this seed.

### 3. Add build script for CI/CD (recommended)
\`\`\`bash
cp nextjs/w2agent-build.mjs your-app/
\`\`\`

Then add to \`package.json\`:
\`\`\`json
{
  "scripts": {
    "prebuild": "node w2agent-build.mjs"
  }
}
\`\`\`

Use \`prebuild\`, not \`postbuild\`: the routes are prerendered during \`next build\`, so a postbuild refresh is not served.
The script crawls your **live** site before each build. The deployed routes serve what the live site showed at build time, which is the previous deploy.

### 4. Mount the WebMCP script (only if \`nextjs/components/WebMcpScript.tsx\` was generated)
Copy \`nextjs/components/WebMcpScript.tsx\` into your app, import it in your root layout
(\`app/layout.tsx\` or \`src/app/layout.tsx\`), and render \`<WebMcpScript />\` inside \`<body>\`.

### 5. robots.txt
\`--install\` stages the generated rules at \`.w2agent/robots.txt\`. That file is not served. Review it and merge it into \`public/robots.txt\` or your \`app/robots.ts\`.

## File Structure

\`\`\`
your-nextjs-app/
  middleware.ts                              <- Content negotiation for AI bots (proxy.ts on Next.js 16; under src/ for src/app projects)
  w2agent-build.mjs                         <- Build-time regeneration script
  .w2agent/
    llms.txt                                <- Generated content (read by route handler)
    llms-full.txt                           <- Generated content (read by route handler)
    index.md                                <- Home page as markdown (read by the /index.md route handler)
    agent-card.json                         <- A2A agent card data (only with --a2a-endpoint)
  app/
    llms.txt/route.ts                       <- Dynamic route handler (ISR)
    llms-full.txt/route.ts                  <- Dynamic route handler (ISR)
    index.md/route.ts                       <- .w2agent/index.md as text/markdown (homepage markdown twin; llms.txt if the file is missing)
    .well-known/agent-card.json/route.ts    <- Agent card route (only with --a2a-endpoint)
\`\`\`

## How It Works

1. **Route handlers** serve content with ISR (revalidates every hour, but re-reads the same deployed file, so new content arrives with the next build; no revalidation under \`cacheComponents\`)
2. **Build script** refreshes \`.w2agent/llms.txt\`, \`llms-full.txt\` and \`index.md\` before each build via \`npx --no -- w2agent generate\` from the live site (the CLI must be installed in your project)
3. **Middleware** (or \`proxy\` on Next.js 16) rewrites \`/\` (also under \`basePath\`) to \`/index.md\` when the request lists \`text/markdown\` at equal or higher q than \`text/html\`, and to \`/llms.txt\` when it lists \`text/plain\` at strictly higher q; browsers, \`*/*\` and \`application/json, text/plain, */*\` keep the HTML page. The rewritten \`/index.md\` and \`/llms.txt\` responses carry \`Vary: Accept\`, but Next.js overwrites \`Vary\` on the HTML page (neither middleware nor \`next.config\` \`headers()\` can add it), so a cache in front of Next must key \`/\` on \`Accept\` itself
4. **Fallback** — if \`.w2agent/index.md\` is missing, \`/index.md\` serves \`.w2agent/llms.txt\`; if that is missing too, the route handler generates minimal content

## Customization

Edit \`app/llms.txt/route.ts\` to customize the fallback generator.
For example, read from your CMS, scan your \`app/\` directory, or query a database.

## Regenerating

\`\`\`bash
# Manual regeneration (needs the w2agent CLI installed in this project)
npx --no -- w2agent generate ${siteUrl} --format llms-txt,full,markdown --no-platform --output ./.w2agent/
# then copy ./.w2agent/markdown/index.md to ./.w2agent/index.md without its front matter, and delete ./.w2agent/markdown/

# Or just build — the prebuild script handles it (the crawl sees the live site, so the previous deploy)
\`\`\`

The CLI is not published on npm yet. Build it from the w2agent repo, then run
\`npm install -D <path-to-w2agent>/packages/cli\` in your app.
`;

  files.push(makeFile("nextjs/middleware.ts", middlewareTs));
  files.push(makeFile("nextjs/app/llms.txt/route.ts", llmsTxtRoute));
  files.push(makeFile("nextjs/app/llms-full.txt/route.ts", llmsFullTxtRoute));
  files.push(makeFile("nextjs/app/index.md/route.ts", indexMdRoute));
  if (agentCardContent) {
    files.push(makeFile("nextjs/app/.well-known/agent-card.json/route.ts", agentCardRoute));
  }
  files.push(makeFile("nextjs/.w2agent/llms.txt", llmsTxtContent));
  files.push(makeFile("nextjs/.w2agent/llms-full.txt", llmsFullTxtContent));
  if (homeMarkdownContent) {
    files.push(makeFile("nextjs/.w2agent/index.md", homeMarkdownContent));
  }
  if (agentCardContent) {
    files.push(makeFile("nextjs/.w2agent/agent-card.json", agentCardContent));
  }
  files.push(makeFile("nextjs/w2agent-build.mjs", buildScript));
  files.push(makeFile("nextjs/INSTALL.md", installMd));

  return files;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return { filename, content, size: new TextEncoder().encode(content).length };
}
