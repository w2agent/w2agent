import type { GeneratedFile } from "../../generate/types.js";
import { HOME_VARIANT_SOURCE } from "../shared/accept-negotiation.js";

export function generateNuxtIntegration(
  llmsTxtContent: string,
  llmsFullTxtContent: string,
  agentCardContent: string | undefined,
  siteUrl: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Nitro's cached handlers only keep headers the handler sets on the response,
  // so each route sets its Content-Type inside the handler.
  // The w2agent module (modules/w2agent.ts) inlines the public/ copies into the server
  // bundle as the "w2agent" server assets at build time, so the routes need no filesystem.
  // A missing file throws a 404 before any header is set, so nothing cacheable is sent.
  const assetRoute = (key: string, contentType: string) => `import { createError } from "h3";
import { defineCachedEventHandler, setResponseHeader, useStorage } from "#imports";

export default defineCachedEventHandler(
  async (event) => {
    const storage = useStorage("assets:w2agent");
    const raw = (await storage.hasItem("${key}")) ? await storage.getItemRaw("${key}") : null;
    if (raw === null || raw === undefined) {
      throw createError({ statusCode: 404, statusMessage: "Not Found" });
    }
    setResponseHeader(event, "Content-Type", "${contentType}");
    return typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
  },
  { swr: true, maxAge: 3600 },
);
`;

  const llmsTxtRoute = assetRoute("llms.txt", "text/plain; charset=utf-8");
  const llmsFullTxtRoute = assetRoute("llms-full.txt", "text/plain; charset=utf-8");

  const w2agentModule = `// w2agent: serve the public/ llms files as of build time.
// Nuxt registers modules/*; this inlines only the listed files into the server bundle.
import { isAbsolute, resolve } from "node:path";

interface W2agentNitroConfig {
  serverAssets?: { baseName: string; dir: string; pattern?: string }[];
}

interface W2agentNuxt {
  options: { dir: { public: string }; srcDir: string };
  hook: (name: "nitro:config", fn: (nitroConfig: W2agentNitroConfig) => void) => unknown;
}

export default function w2agent(_options: unknown, nuxt: W2agentNuxt) {
  nuxt.hook("nitro:config", (nitroConfig) => {
    const configured = nuxt.options.dir.public;
    const dir = isAbsolute(configured) ? configured : resolve(nuxt.options.srcDir, configured);
    nitroConfig.serverAssets ||= [];
    nitroConfig.serverAssets.push({
      baseName: "w2agent",
      dir,
      pattern: "{llms.txt,llms-full.txt,agent-card.json,.well-known/agent-card.json}",
    });
  });
}
`;

  const agentCardRoute = `import { defineCachedEventHandler, setResponseHeader } from "#imports";

const agentCard = ${agentCardContent};

export default defineCachedEventHandler(
  (event) => {
    setResponseHeader(event, "Content-Type", "application/json");
    return agentCard;
  },
  { swr: true, maxAge: 3600 },
);
`;

  // Markdown twin of the homepage: the llms.txt content served as text/markdown
  const indexMdRoute = assetRoute("llms.txt", "text/markdown; charset=utf-8");

  const contentNegotiationMiddleware = `import { appendResponseHeader, defineEventHandler, getRequestHeader, sendRedirect } from "h3";

${HOME_VARIANT_SOURCE}

export default defineEventHandler((event) => {
  // event.path includes the query string; negotiate on the pathname only
  if (event.path.split("?")[0] !== "/") return;

  // Content negotiation: markdown gets /index.md, plain text gets /llms.txt, everything else the page
  const variant = homeVariant(getRequestHeader(event, "accept") ?? null);
  // "/" depends on Accept in every branch: caches must not mix the variants
  appendResponseHeader(event, "Vary", "Accept");
  if (variant === "markdown") return sendRedirect(event, "index.md", 302);
  if (variant === "plain") return sendRedirect(event, "llms.txt", 302);
});
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
 * It must run before the build: Nuxt copies public/ into .output/public during
 * the build, so a postbuild refresh would not reach the deployed output.
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
    "or the crawl of " + SITE_URL + " failed. Nitro routes serve the public/ files as of the last build and return 404 while public/llms.txt is missing."
  );
}
`;

  const installMd = `# w2agent Nuxt Integration — Installation

## Recommended: npm package

The easiest way to add w2agent to your Nuxt app is the npm module:

\`\`\`bash
npm install @w2agent/nuxt
\`\`\`

Then add to \`nuxt.config.ts\`:
\`\`\`ts
export default defineNuxtConfig({
  modules: ['@w2agent/nuxt'],
  w2agent: { siteUrl: '${siteUrl}' },
})
\`\`\`

The module auto-registers all Nitro routes. No manual file copying needed.

---

## Alternative: Manual file setup (below)

## Architecture

This integration uses **Nitro cached event handlers**. A small local module
(\`modules/w2agent.ts\`) inlines \`public/llms.txt\`, \`public/llms-full.txt\` and the agent card
into the server bundle at build time. Content is cached for 1 hour with SWR.

\`\`\`
nuxi build
  -> modules/w2agent.ts bundles those public/ files into the server
Request for /llms.txt
  -> Nitro cached handler serves the bundled copy (no filesystem, any working directory)
  -> Returns with 1hr cache + stale-while-revalidate
  -> If the file was missing at build time, returns 404
\`\`\`

The routes serve the \`public/\` files as they were when you built. Run the build script (or
\`w2agent generate\`) before \`nuxi build\`; a file generated afterwards is not served until the next build.

## Setup

### 1. Copy Nitro server routes and the module
\`\`\`bash
cp -r nuxt/server/ your-nuxt-app/server/
cp -r nuxt/modules/ your-nuxt-app/modules/
\`\`\`

### 2. Copy the seed files
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
    "prebuild": "node w2agent-build.mjs"
  }
}
\`\`\`

It runs as \`prebuild\` so the files land in \`public/\` before Nuxt copies it into the build output.
It needs the w2agent CLI installed in your project. The CLI is not published on npm yet: build it
from the w2agent repo, then run \`npm install -D <path-to-w2agent>/packages/cli\`.

## File Structure

\`\`\`
your-nuxt-app/
  w2agent-build.mjs                                    <- Build-time regeneration
  modules/
    w2agent.ts                                         <- Bundles the public/ llms files into the server at build time
  server/
    routes/
      llms.txt.ts                                      <- Cached Nitro handler
      llms-full.txt.ts                                 <- Cached Nitro handler
      index.md.ts                                      <- llms.txt as text/markdown (homepage markdown twin)
      .well-known/agent-card.json.ts                   <- Cached A2A agent card (only with --a2a-endpoint)
    middleware/
      content-negotiation.ts                           <- AI bot content negotiation
  public/
    llms.txt                                           <- Content served as of the last build
    llms-full.txt                                      <- Content served as of the last build
\`\`\`

## How It Works

1. **Nitro handlers** serve content with 1hr cache + stale-while-revalidate
2. **Build script** regenerates \`public/\` files before each build via \`npx --no -- w2agent generate\`
3. **Middleware** redirects \`/\` (with \`Vary: Accept\`) to \`/index.md\` when the request lists \`text/markdown\` at equal or higher q than \`text/html\`, and to \`/llms.txt\` when it lists \`text/plain\` at strictly higher q; browsers, \`*/*\` and \`application/json, text/plain, */*\` keep the HTML page
4. **Missing file** — if \`public/llms.txt\` (or \`llms-full.txt\`) did not exist at build time, its routes return 404 instead of placeholder content

## Regenerating

\`\`\`bash
# Manual
npx --no -- w2agent generate ${siteUrl} --format llms-txt,full --no-platform --output ./public/

# Or just build — the prebuild script handles it
\`\`\`
`;

  files.push(makeFile("nuxt/modules/w2agent.ts", w2agentModule));
  files.push(makeFile("nuxt/server/routes/llms.txt.ts", llmsTxtRoute));
  files.push(makeFile("nuxt/server/routes/llms-full.txt.ts", llmsFullTxtRoute));
  files.push(makeFile("nuxt/server/routes/index.md.ts", indexMdRoute));
  if (agentCardContent) {
    files.push(makeFile("nuxt/server/routes/.well-known/agent-card.json.ts", agentCardRoute));
  }
  files.push(
    makeFile("nuxt/server/middleware/content-negotiation.ts", contentNegotiationMiddleware),
  );
  files.push(makeFile("nuxt/public/llms.txt", llmsTxtContent));
  files.push(makeFile("nuxt/public/llms-full.txt", llmsFullTxtContent));
  files.push(makeFile("nuxt/w2agent-build.mjs", buildScript));
  files.push(makeFile("nuxt/INSTALL.md", installMd));

  return files;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return { filename, content, size: new TextEncoder().encode(content).length };
}
