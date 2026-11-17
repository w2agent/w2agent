import type { GeneratedFile } from "../../generate/types.js";

export function generateAstroIntegration(
  llmsTxtContent: string,
  llmsFullTxtContent: string,
  agentCardContent: string | undefined,
  siteUrl: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // SSR API endpoint for /llms.txt (used when output: "server")
  const llmsTxtEndpoint = `import type { APIRoute } from "astro";
import fs from "node:fs";
import path from "node:path";

// Rendered on demand, so the project needs an adapter: output "server", or static
// output with an adapter (Astro 5+). Without one the build fails with NoAdapterInstalled.
export const prerender = false;

export const GET: APIRoute = async () => {
  // Read from generated static file
  const filePath = path.join(process.cwd(), "public", "llms.txt");
  if (!fs.existsSync(filePath)) {
    return new Response("Not Found", { status: 404 });
  }
  const content = fs.readFileSync(filePath, "utf-8");
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
 * Regenerates llms-full.txt after each build, and llms.txt too unless the project
 * has its own public/llms.txt (Astro copies it into the build and it is kept).
 * To regenerate llms.txt as well: w2agent({ overwrite: true })
 *
 * Requires the w2agent CLI installed in this project. It is not published on npm
 * yet: build it from the w2agent repo, then run
 *   npm install -D <path-to-w2agent>/packages/cli
 * (npx runs with --no, so it never downloads a package.)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export default function w2agentIntegration(options = {}) {
  const overwrite = options.overwrite === true;
  let siteRoot = process.cwd();
  let publicDir = join(siteRoot, "public");

  return {
    name: "w2agent",
    hooks: {
      "astro:config:done": ({ config }) => {
        siteRoot = fileURLToPath(config.root);
        publicDir = config.publicDir
          ? typeof config.publicDir === "string" ? config.publicDir : fileURLToPath(config.publicDir)
          : join(siteRoot, "public");
      },
      "astro:build:done": async ({ dir, logger }) => {
        const siteUrl = process.env.SITE_URL || ${JSON.stringify(siteUrl)};
        const outDir = fileURLToPath(dir);
        const existing = join(publicDir, "llms.txt");
        const keep = !overwrite && existsSync(existing);

        logger.info("Regenerating AI content for " + siteUrl + "...");
        if (keep) {
          logger.info(
            "Keeping existing " + relative(siteRoot, existing) + "; set overwrite: true to replace it with a generated llms.txt"
          );
        }

        try {
          execFileSync(
            "npx",
            ["--no", "--", "w2agent", "generate", siteUrl, "--format", keep ? "full" : "llms-txt,full", "--no-platform", "--output", outDir],
            { stdio: "inherit" }
          );
          logger.info("Done. Files written to " + outDir);
        } catch (err) {
          logger.warn(
            "Generation failed: " + (err && err.message ? err.message : String(err)) + "\\n" +
            "Either the w2agent CLI is not installed in this project (it is not published on npm yet: " +
            "build it from the w2agent repo, then run npm install -D <path-to-w2agent>/packages/cli) " +
            "or the crawl of " + siteUrl + " failed. Static fallback files will be used."
          );
        }
      },
    },
  };
}
`;

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
 * It must run before the build: Astro copies public/ into dist/ during the
 * build, so a postbuild refresh would not reach the deployed output.
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
    ["--no", "--", "w2agent", "generate", SITE_URL, "--format", "llms-txt,full", "--no-platform", "--output", "./public/"],
    { stdio: "inherit" }
  );
  console.log("[w2agent] Done. Files written to public/");
} catch (err) {
  console.warn(
    "[w2agent] Generation failed: " + (err && err.message ? err.message : String(err)) + "\\n" +
    "[w2agent] Either the w2agent CLI is not installed in this project (it is not published on npm yet: " +
    "build it from the w2agent repo, then run npm install -D <path-to-w2agent>/packages/cli) " +
    "or the crawl of " + SITE_URL + " failed. Static files will be used as fallback."
  );
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
  integrations: [w2agent()],
});
\`\`\`

In a static build the package lists the built pages in \`llms.txt\`. An existing \`public/llms.txt\` is kept as is; pass \`w2agent({ overwrite: true })\` to replace it with the generated index. \`llms-full.txt\` is only produced by \`w2agent generate\`.

---

## Alternative: Manual file setup (below)

## Architecture

Astro's static-first approach is ideal for AI content. This integration provides:
- **Static files** in \`public/\` (primary, works with any hosting)
- **SSR endpoints** for dynamic content (when using \`output: "server"\`)
- **Build integration** to regenerate content on each deploy

\`\`\`
Build time:
  -> w2agent integration runs at astro:build:done
  -> Writes llms-full.txt to the output directory, and llms.txt too with overwrite: true (needs the w2agent CLI installed in your project)

Runtime (static):
  -> Serve directly from public/ (zero overhead)

Runtime (SSR):
  -> API endpoints read from public/ with cache headers
  -> Answers 404 when a file is missing
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
  integrations: [w2agent({ overwrite: true })],
});
\`\`\`

The \`public/llms.txt\` copied in step 1 is w2agent output, so \`overwrite: true\` lets every build regenerate it. A hand-written \`public/llms.txt\` is kept with plain \`w2agent()\`: Astro copies it into the build and the integration only regenerates \`llms-full.txt\`.

### Alternative: prebuild script
\`\`\`bash
cp astro/w2agent-build.mjs your-astro-app/
\`\`\`

Instead of the integration, \`w2agent-build.mjs\` can run as \`"prebuild": "node w2agent-build.mjs"\` and writes into \`public/\`. Use one of the two, not both, or the site is crawled twice per build. The script replaces \`public/llms.txt\` and \`public/llms-full.txt\` on every run, so do not use it when you write \`public/llms.txt\` by hand.
\n### 3. (Optional) Add SSR endpoints
These endpoints render on demand, so the project needs an adapter: \`output: "server"\` with an adapter, or static output with an adapter (Astro 5+). In a static project without an adapter the build fails with \`NoAdapterInstalled\`; skip this step there and serve the files in \`public/\` as they are.
\`\`\`bash
cp astro/src/pages/llms.txt.ts your-astro-app/src/pages/
cp -r astro/src/pages/.well-known/ your-astro-app/src/pages/.well-known/
\`\`\`

## File Structure

\`\`\`
your-astro-app/
  w2agent-integration.mjs                             <- Build integration plugin
  w2agent-build.mjs                                   <- CI/CD build script (run as "prebuild")
  public/
    llms.txt                                          <- Static file (primary)
    llms-full.txt                                     <- Static file
    .well-known/
      agent-card.json                                 <- Static A2A agent card (only with --a2a-endpoint)
  src/pages/
    llms.txt.ts                                       <- SSR endpoint (optional)
    .well-known/
      agent-card.json.ts                              <- SSR endpoint (only with --a2a-endpoint)
\`\`\`

## Regenerating

\`\`\`bash
# Manual (needs the w2agent CLI installed in this project)
npx --no -- w2agent generate ${siteUrl} --format llms-txt,full --no-platform --output ./public/

# Or just deploy — the build integration handles it
\`\`\`

The CLI is not published on npm yet. Build it from the w2agent repo, then run
\`npm install -D <path-to-w2agent>/packages/cli\` in your app.
`;

  // Static files first (Astro's strength)
  files.push(makeFile("astro/public/llms.txt", llmsTxtContent));
  files.push(makeFile("astro/public/llms-full.txt", llmsFullTxtContent));
  if (agentCardContent) {
    files.push(makeFile("astro/public/.well-known/agent-card.json", agentCardContent));
  }
  // SSR endpoints
  files.push(makeFile("astro/src/pages/llms.txt.ts", llmsTxtEndpoint));
  if (agentCardContent) {
    files.push(makeFile("astro/src/pages/.well-known/agent-card.json.ts", agentCardEndpoint));
  }
  // Build tools
  files.push(makeFile("astro/w2agent-integration.mjs", integrationPlugin));
  files.push(makeFile("astro/w2agent-build.mjs", buildScript));
  files.push(makeFile("astro/INSTALL.md", installMd));

  return files;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return { filename, content, size: new TextEncoder().encode(content).length };
}
