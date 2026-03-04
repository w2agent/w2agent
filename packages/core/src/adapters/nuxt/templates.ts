import type { GeneratedFile } from "../../generate/types.js";

export function generateNuxtIntegration(
  llmsTxtContent: string,
  llmsFullTxtContent: string,
  agentCardContent: string,
  siteUrl: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  const llmsTxtRoute = `import { defineCachedEventHandler } from "#imports";

export default defineCachedEventHandler(
  async () => {
    // Read from generated static file, or customize with your own content source
    const fs = await import("node:fs");
    const path = await import("node:path");
    const filePath = path.join(process.cwd(), "public", "llms.txt");
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
    // Fallback: minimal llms.txt
    const host = "${siteUrl}".replace(/^https?:\\/\\//, "");
    return "# " + host + "\\n\\n> AI-ready content index\\n\\n" +
      "## Pages\\n\\n- [Home](${siteUrl}): Main page\\n";
  },
  {
    swr: true,
    maxAge: 3600,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  },
);
`;

  const llmsFullTxtRoute = `import { defineCachedEventHandler } from "#imports";

export default defineCachedEventHandler(
  async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const filePath = path.join(process.cwd(), "public", "llms-full.txt");
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
    return "# No content generated yet\\n\\nRun: npx w2agent generate ${siteUrl}\\n";
  },
  {
    swr: true,
    maxAge: 3600,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  },
);
`;

  const agentCardRoute = `import { defineCachedEventHandler } from "#imports";

const agentCard = ${agentCardContent};

export default defineCachedEventHandler(
  () => agentCard,
  {
    swr: true,
    maxAge: 3600,
    headers: { "Content-Type": "application/json" },
  },
);
`;

  const contentNegotiationMiddleware = `import { defineEventHandler, getRequestHeader, sendRedirect } from "h3";

export default defineEventHandler((event) => {
  const url = event.path;
  const accept = getRequestHeader(event, "accept") || "";

  // Content negotiation: AI bots requesting markdown/plain text at root get llms.txt
  if (
    url === "/" &&
    (accept.includes("text/markdown") || accept.includes("text/plain"))
  ) {
    return sendRedirect(event, "/llms.txt", 302);
  }
});
`;

  const buildScript = `#!/usr/bin/env node
/**
 * w2agent build script — run during CI/CD or as a postbuild hook
 *
 * Usage:
 *   node w2agent-build.mjs
 *
 * Or add to package.json:
 *   "scripts": { "postbuild": "node w2agent-build.mjs" }
 */
import { execFileSync } from "node:child_process";

const SITE_URL = process.env.SITE_URL || "${siteUrl}";

console.log("[w2agent] Regenerating AI content for " + SITE_URL + "...");

try {
  execFileSync(
    "npx",
    ["w2agent", "generate", SITE_URL, "--format", "llms-txt", "--format", "full", "--output", "./public/"],
    { stdio: "inherit" }
  );
  console.log("[w2agent] Done. Files written to public/");
} catch (err) {
  console.warn("[w2agent] Generation failed — Nitro routes will use fallback content");
}
`;

  const installMd = `# w2agent Nuxt Integration — Installation

## Architecture

This integration uses **Nitro cached event handlers** for dynamic content
and static \`public/\` files as fallback. Content is cached for 1 hour with SWR.

\`\`\`
Request for /llms.txt
  -> Nitro cached handler reads public/llms.txt
  -> Returns with 1hr cache + stale-while-revalidate
  -> If file missing, generates minimal fallback
\`\`\`

## Setup

### 1. Copy Nitro server routes
\`\`\`bash
cp -r nuxt/server/ your-nuxt-app/server/
\`\`\`

### 2. Copy static fallback files
\`\`\`bash
cp nuxt/public/llms.txt your-nuxt-app/public/
cp nuxt/public/llms-full.txt your-nuxt-app/public/
\`\`\`

### 3. Add build script (recommended)
\`\`\`bash
cp nuxt/w2agent-build.mjs your-nuxt-app/
\`\`\`

Then add to \`package.json\`:
\`\`\`json
{
  "scripts": {
    "postbuild": "node w2agent-build.mjs"
  }
}
\`\`\`

## File Structure

\`\`\`
your-nuxt-app/
  w2agent-build.mjs                                    <- Build-time regeneration
  server/
    routes/
      llms.txt.ts                                      <- Cached Nitro handler
      llms-full.txt.ts                                 <- Cached Nitro handler
      .well-known/agent-card.json.ts                   <- Cached JSON handler
    middleware/
      content-negotiation.ts                           <- AI bot content negotiation
  public/
    llms.txt                                           <- Static fallback
    llms-full.txt                                      <- Static fallback
\`\`\`

## How It Works

1. **Nitro handlers** serve content with 1hr cache + stale-while-revalidate
2. **Build script** regenerates \`public/\` files on deploy via \`npx w2agent generate\`
3. **Middleware** redirects AI bots requesting \`Accept: text/markdown\` to \`/llms.txt\`
4. **Fallback** — if static files are missing, handlers generate minimal content

## Regenerating

\`\`\`bash
# Manual
npx w2agent generate ${siteUrl} --output ./public/

# Or just deploy — the postbuild script handles it
\`\`\`
`;

  files.push(makeFile("nuxt/server/routes/llms.txt.ts", llmsTxtRoute));
  files.push(makeFile("nuxt/server/routes/llms-full.txt.ts", llmsFullTxtRoute));
  files.push(makeFile("nuxt/server/routes/.well-known/agent-card.json.ts", agentCardRoute));
  files.push(makeFile("nuxt/server/middleware/content-negotiation.ts", contentNegotiationMiddleware));
  files.push(makeFile("nuxt/public/llms.txt", llmsTxtContent));
  files.push(makeFile("nuxt/public/llms-full.txt", llmsFullTxtContent));
  files.push(makeFile("nuxt/w2agent-build.mjs", buildScript));
  files.push(makeFile("nuxt/INSTALL.md", installMd));

  return files;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return { filename, content, size: new TextEncoder().encode(content).length };
}
