import type { GeneratedFile } from "../../generate/types.js";

export function generateNextjsIntegration(
  llmsTxtContent: string,
  llmsFullTxtContent: string,
  agentCardContent: string,
  siteUrl: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  const middlewareTs = `/* eslint-disable */
import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Content negotiation: AI bots requesting markdown get redirected to /llms.txt
  const accept = request.headers.get("accept") || "";
  if (
    pathname === "/" &&
    (accept.includes("text/markdown") || accept.includes("text/plain"))
  ) {
    return NextResponse.rewrite(new URL("/llms.txt", request.url));
  }

  return NextResponse.next();
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

  return new NextResponse("# No content generated yet\\n\\nRun: npx w2agent generate ${siteUrl}\\n", {
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

  // Fallback — return minimal agent card
  return NextResponse.json({ "@context": "https://schema.org", "@type": "WebSite", "url": "${siteUrl}" }, {
    headers: {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
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
 */
import { execFileSync } from "node:child_process";

const SITE_URL = process.env.SITE_URL || "${siteUrl}";

console.log("[w2agent] Regenerating AI content for " + SITE_URL + "...");

try {
  execFileSync(
    "npx",
    ["w2agent", "generate", SITE_URL, "--format", "llms-txt", "--format", "full", "--output", "./.w2agent/"],
    { stdio: "inherit" }
  );
  console.log("[w2agent] Done. Files written to .w2agent/");
} catch (err) {
  console.warn("[w2agent] Generation failed — route handlers will use fallback content");
  // Non-fatal: the route handlers have fallback logic
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

## File Structure

\`\`\`
your-nextjs-app/
  middleware.ts                              <- Content negotiation for AI bots
  w2agent-build.mjs                         <- Build-time regeneration script
  .w2agent/
    llms.txt                                <- Generated content (read by route handler)
    llms-full.txt                           <- Generated content (read by route handler)
    agent-card.json                         <- Agent card data (read by route handler)
  app/
    llms.txt/route.ts                       <- Dynamic route handler (ISR)
    llms-full.txt/route.ts                  <- Dynamic route handler (ISR)
    .well-known/agent-card.json/route.ts    <- Dynamic agent card
\`\`\`

## How It Works

1. **Route handlers** serve content with ISR (revalidates every hour)
2. **Build script** regenerates \`.w2agent/llms.txt\` on deploy via \`npx w2agent generate\`
3. **Middleware** redirects AI bots requesting \`Accept: text/markdown\` to \`/llms.txt\`
4. **Fallback** — if \`.w2agent/llms.txt\` is missing, the route handler generates minimal content

## Customization

Edit \`app/llms.txt/route.ts\` to customize the fallback generator.
For example, read from your CMS, scan your \`app/\` directory, or query a database.

## Regenerating

\`\`\`bash
# Manual regeneration
npx w2agent generate ${siteUrl} --output ./.w2agent/

# Or just deploy — the postbuild script handles it
\`\`\`
`;

  files.push(makeFile("nextjs/middleware.ts", middlewareTs));
  files.push(makeFile("nextjs/app/llms.txt/route.ts", llmsTxtRoute));
  files.push(makeFile("nextjs/app/llms-full.txt/route.ts", llmsFullTxtRoute));
  files.push(makeFile("nextjs/app/.well-known/agent-card.json/route.ts", agentCardRoute));
  files.push(makeFile("nextjs/.w2agent/llms.txt", llmsTxtContent));
  files.push(makeFile("nextjs/.w2agent/llms-full.txt", llmsFullTxtContent));
  files.push(makeFile("nextjs/.w2agent/agent-card.json", agentCardContent));
  files.push(makeFile("nextjs/w2agent-build.mjs", buildScript));
  files.push(makeFile("nextjs/INSTALL.md", installMd));

  return files;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return { filename, content, size: new TextEncoder().encode(content).length };
}
