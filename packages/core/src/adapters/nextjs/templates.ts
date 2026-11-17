import type { GeneratedFile } from "../../generate/types.js";
import { HOME_VARIANT_SOURCE } from "../shared/accept-negotiation.js";

export function generateNextjsIntegration(
  llmsTxtContent: string,
  llmsFullTxtContent: string,
  agentCardContent: string | undefined,
  siteUrl: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  const middlewareTs = `/* eslint-disable */
import { NextRequest, NextResponse } from "next/server";

${HOME_VARIANT_SOURCE}

export function middleware(request: NextRequest) {
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

  // Dynamic route handler for /llms.txt — ISR, regenerates every hour
  const llmsTxtRoute = `/* eslint-disable */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

// ISR: regenerate every hour
export const revalidate = 3600;

export async function GET() {
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

function generateLlmsTxtFromPages(): string {
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

  // Markdown twin of the homepage: the llms.txt content served as text/markdown
  const indexMdRoute = `/* eslint-disable */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const revalidate = 3600;

export async function GET() {
  // Same content as /llms.txt: the generated file, or a minimal fallback
  const filePath = path.join(process.cwd(), ".w2agent", "llms.txt");
  const host = "${siteUrl}".replace(/^https?:\\/\\//, "");
  const content = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
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

export const revalidate = 3600;

export async function GET() {
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

export const revalidate = 3600;

export async function GET() {
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
 * w2agent build script — run during CI/CD or as a postbuild hook
 *
 * Usage:
 *   node w2agent-build.mjs
 *
 * Or add to package.json:
 *   "scripts": { "postbuild": "node w2agent-build.mjs" }
 *
 * This regenerates llms.txt and llms-full.txt from your live site,
 * so your route handlers always serve fresh content.
 *
 * Requires the w2agent CLI installed in this project. It is not published on npm
 * yet: build it from the w2agent repo, then run
 *   npm install -D <path-to-w2agent>/packages/cli
 * (npx runs with --no, so it never downloads a package.)
 */
import { execFileSync } from "node:child_process";

const SITE_URL = process.env.SITE_URL || ${JSON.stringify(siteUrl)};

console.log("[w2agent] Regenerating AI content for " + SITE_URL + "...");

try {
  execFileSync(
    "npx",
    ["--no", "--", "w2agent", "generate", SITE_URL, "--format", "llms-txt,full", "--no-platform", "--output", "./.w2agent/"],
    { stdio: "inherit" }
  );
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

This integration uses **dynamic route handlers** with ISR (Incremental Static Regeneration),
not just static files. Your AI content stays fresh automatically.

\`\`\`
Request for /llms.txt
  -> Route handler reads .w2agent/llms.txt (generated by build script)
  -> Returns with Cache-Control + ISR revalidation
  -> If file missing, generates minimal fallback from page data
\`\`\`

## Setup

### 1. Copy route handlers
\`\`\`bash
cp -r nextjs/app/ your-app/app/
cp nextjs/middleware.ts your-app/
\`\`\`

### 2. Copy seed files (immediate content)
\`\`\`bash
cp -r nextjs/.w2agent/ your-app/.w2agent/
\`\`\`

### 3. Add build script for CI/CD (recommended)
\`\`\`bash
cp nextjs/w2agent-build.mjs your-app/
\`\`\`

Then add to \`package.json\`:
\`\`\`json
{
  "scripts": {
    "postbuild": "node w2agent-build.mjs"
  }
}
\`\`\`

This regenerates your AI content on every deploy.

### 4. Mount the WebMCP script (only if \`nextjs/components/WebMcpScript.tsx\` was generated)
Copy \`nextjs/components/WebMcpScript.tsx\` into your app, import it in your root layout
(\`app/layout.tsx\` or \`src/app/layout.tsx\`), and render \`<WebMcpScript />\` inside \`<body>\`.

## File Structure

\`\`\`
your-nextjs-app/
  middleware.ts                              <- Content negotiation for AI bots
  w2agent-build.mjs                         <- Build-time regeneration script
  .w2agent/
    llms.txt                                <- Generated content (read by route handler)
    llms-full.txt                           <- Generated content (read by route handler)
    agent-card.json                         <- A2A agent card data (only with --a2a-endpoint)
  app/
    llms.txt/route.ts                       <- Dynamic route handler (ISR)
    llms-full.txt/route.ts                  <- Dynamic route handler (ISR)
    index.md/route.ts                       <- llms.txt as text/markdown (homepage markdown twin)
    .well-known/agent-card.json/route.ts    <- Agent card route (only with --a2a-endpoint)
\`\`\`

## How It Works

1. **Route handlers** serve content with ISR (revalidates every hour)
2. **Build script** regenerates \`.w2agent/llms.txt\` on deploy via \`npx --no -- w2agent generate\` (the CLI must be installed in your project)
3. **Middleware** rewrites \`/\` (also under \`basePath\`, with \`Vary: Accept\`) to \`/index.md\` when the request lists \`text/markdown\` at equal or higher q than \`text/html\`, and to \`/llms.txt\` when it lists \`text/plain\` at strictly higher q; browsers, \`*/*\` and \`application/json, text/plain, */*\` keep the HTML page
4. **Fallback** — if \`.w2agent/llms.txt\` is missing, the route handler generates minimal content

## Customization

Edit \`app/llms.txt/route.ts\` to customize the fallback generator.
For example, read from your CMS, scan your \`app/\` directory, or query a database.

## Regenerating

\`\`\`bash
# Manual regeneration (needs the w2agent CLI installed in this project)
npx --no -- w2agent generate ${siteUrl} --format llms-txt,full --no-platform --output ./.w2agent/

# Or just deploy — the postbuild script handles it
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
