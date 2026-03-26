import type { GeneratedFile } from "../../generate/types.js";

export function generateAstroIntegration(
  llmsTxtContent: string,
  llmsFullTxtContent: string,
  agentCardContent: string,
  siteUrl: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // SSR API endpoint for /llms.txt (used when output: "server" or "hybrid")
  const llmsTxtEndpoint = `import type { APIRoute } from "astro";
import fs from "node:fs";
import path from "node:path";

export const GET: APIRoute = async () => {
  // Read from generated static file
  const filePath = path.join(process.cwd(), "public", "llms.txt");
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    return new Response(content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  }

  // Fallback
  const host = "${siteUrl}".replace(/^https?:\\/\\//, "");
  const content = "# " + host + "\\n\\n> AI-ready content index\\n\\n" +
    "## Pages\\n\\n- [Home](${siteUrl}): Main page\\n";
  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
};
`;

  const agentCardEndpoint = `import type { APIRoute } from "astro";

const agentCard = ${agentCardContent};

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify(agentCard, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
};
`;

  // Astro integration plugin — regenerates files at build time
  const integrationPlugin = `/**
 * w2agent Astro Integration
 *
 * Add to astro.config.mjs:
 *   import w2agent from "./w2agent-integration.mjs";
 *   export default defineConfig({ integrations: [w2agent()] });
 *
 * Regenerates llms.txt and llms-full.txt after each build.
 */
import { execFileSync } from "node:child_process";

export default function w2agentIntegration() {
  return {
    name: "w2agent",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const siteUrl = process.env.SITE_URL || "${siteUrl}";
        const outDir = dir.pathname;

        logger.info("Regenerating AI content for " + siteUrl + "...");

        try {
          execFileSync(
            "npx",
            ["w2agent", "generate", siteUrl, "--format", "llms-txt", "--format", "full", "--output", outDir],
            { stdio: "inherit" }
          );
          logger.info("Done. Files written to " + outDir);
        } catch (err) {
          logger.warn("Generation failed — static fallback files will be used");
        }
      },
    },
  };
}
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
  console.warn("[w2agent] Generation failed — static files will be used as fallback");
}
`;

  const installMd = `# w2agent Astro Integration — Installation

## Recommended: npm integration

\`\`\`bash
npx astro add @w2agent/astro
\`\`\`

Then configure in \`astro.config.mjs\`:
\`\`\`js
import w2agent from '@w2agent/astro';
export default defineConfig({
  integrations: [w2agent({ siteUrl: '${siteUrl}' })],
});
\`\`\`

---

## Alternative: Manual file setup (below)

## Architecture

Astro's static-first approach is ideal for AI content. This integration provides:
- **Static files** in \`public/\` (primary, works with any hosting)
- **SSR endpoints** for dynamic content (when using \`output: "server"\` or \`"hybrid"\`)
- **Build integration** to regenerate content on each deploy

\`\`\`
Build time:
  -> w2agent integration runs at astro:build:done
  -> Writes llms.txt, llms-full.txt to output directory

Runtime (static):
  -> Serve directly from public/ (zero overhead)

Runtime (SSR):
  -> API endpoints read from public/ with cache headers
  -> Fallback generates minimal content if files missing
\`\`\`

## Setup

### 1. Copy static files (works immediately)
\`\`\`bash
cp astro/public/llms.txt your-astro-app/public/
cp astro/public/llms-full.txt your-astro-app/public/
cp -r astro/public/.well-known/ your-astro-app/public/.well-known/
\`\`\`

### 2. Add build integration (recommended)
\`\`\`bash
cp astro/w2agent-integration.mjs your-astro-app/
\`\`\`

Then in \`astro.config.mjs\`:
\`\`\`js
import w2agent from "./w2agent-integration.mjs";

export default defineConfig({
  integrations: [w2agent()],
});
\`\`\`

### 3. (Optional) Add SSR endpoints
If using \`output: "server"\` or \`"hybrid"\`:
\`\`\`bash
cp astro/src/pages/llms.txt.ts your-astro-app/src/pages/
cp -r astro/src/pages/.well-known/ your-astro-app/src/pages/.well-known/
\`\`\`

## File Structure

\`\`\`
your-astro-app/
  w2agent-integration.mjs                             <- Build integration plugin
  w2agent-build.mjs                                   <- CI/CD build script
  public/
    llms.txt                                          <- Static file (primary)
    llms-full.txt                                     <- Static file
    .well-known/
      agent-card.json                                 <- Static agent card
  src/pages/
    llms.txt.ts                                       <- SSR endpoint (optional)
    .well-known/
      agent-card.json.ts                              <- SSR endpoint (optional)
\`\`\`

## Regenerating

\`\`\`bash
# Manual
npx w2agent generate ${siteUrl} --output ./public/

# Or just deploy — the build integration handles it
\`\`\`
`;

  // Static files first (Astro's strength)
  files.push(makeFile("astro/public/llms.txt", llmsTxtContent));
  files.push(makeFile("astro/public/llms-full.txt", llmsFullTxtContent));
  files.push(makeFile("astro/public/.well-known/agent-card.json", agentCardContent));
  // SSR endpoints
  files.push(makeFile("astro/src/pages/llms.txt.ts", llmsTxtEndpoint));
  files.push(makeFile("astro/src/pages/.well-known/agent-card.json.ts", agentCardEndpoint));
  // Build tools
  files.push(makeFile("astro/w2agent-integration.mjs", integrationPlugin));
  files.push(makeFile("astro/w2agent-build.mjs", buildScript));
  files.push(makeFile("astro/INSTALL.md", installMd));

  return files;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return { filename, content, size: new TextEncoder().encode(content).length };
}
