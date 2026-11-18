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
 * Regenerates llms.txt and llms-full.txt after each build, except a file the project
 * already has in public/ (Astro copies it into the build and it is kept).
 * To regenerate files that exist in public/: w2agent({ overwrite: true }) for both,
 * or w2agent({ overwrite: ["llms-full.txt"] }) for the listed ones.
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

const FORMATS = { "llms.txt": "llms-txt", "llms-full.txt": "full" };

export default function w2agentIntegration(options = {}) {
  const given = options.overwrite === void 0 ? false : options.overwrite;
  if (
    given !== false && given !== true &&
    !(Array.isArray(given) && given.every((name) => Object.keys(FORMATS).includes(name)))
  ) {
    throw new Error('w2agent: overwrite must be true, false or an array of "llms.txt" and "llms-full.txt"');
  }
  const overwrite = given === true ? Object.keys(FORMATS) : Array.isArray(given) ? given : [];
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
        const names = Object.keys(FORMATS);
        const kept = names.filter((name) => !overwrite.includes(name) && existsSync(join(publicDir, name)));
        for (const name of kept) {
          logger.info(
            "Keeping existing " + relative(siteRoot, join(publicDir, name)) + "; set overwrite: true or overwrite: [" + JSON.stringify(name) + "] to replace it with a generated " + name
          );
        }
        const formats = names.filter((name) => !kept.includes(name)).map((name) => FORMATS[name]);
        if (formats.length === 0) return;

        logger.info("Regenerating AI content for " + siteUrl + "...");

        try {
          execFileSync(
            "npx",
            ["--no", "--", "w2agent", "generate", siteUrl, "--format", formats.join(","), "--no-platform", "--output", outDir],
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
 *   node w2agent-build.mjs [--overwrite | --overwrite=llms.txt,llms-full.txt]
 *
 * Or add to package.json:
 *   "scripts": { "prebuild": "node w2agent-build.mjs --overwrite" }
 *
 * It writes llms.txt and llms-full.txt into public/, except a file that already
 * exists there. --overwrite replaces both; --overwrite=<names> replaces the
 * comma-separated files only. Without it, a plain run only fills missing files.
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
import { existsSync } from "node:fs";
import { join } from "node:path";

const SITE_URL = process.env.SITE_URL || ${JSON.stringify(siteUrl)};
const FORMATS = { "llms.txt": "llms-txt", "llms-full.txt": "full" };

const names = Object.keys(FORMATS);

function parseOverwrite(args) {
  if (args.length === 0) return [];
  if (args.length > 1) return null;
  if (args[0] === "--overwrite") return names;
  if (!args[0].startsWith("--overwrite=")) return null;
  const list = args[0].slice("--overwrite=".length).split(",");
  return list.every((name) => names.includes(name)) ? list : null;
}

const overwrite = parseOverwrite(process.argv.slice(2));
if (overwrite === null) {
  console.error("[w2agent] Usage: node w2agent-build.mjs [--overwrite | --overwrite=llms.txt,llms-full.txt]");
  process.exit(1);
}

const kept = names.filter((name) => !overwrite.includes(name) && existsSync(join("public", name)));
for (const name of kept) {
  console.log("[w2agent] Keeping existing public/" + name + "; pass --overwrite or --overwrite=" + name + " to replace it");
}
const formats = names.filter((name) => !kept.includes(name)).map((name) => FORMATS[name]);
if (formats.length === 0) process.exit(0);

console.log("[w2agent] Regenerating AI content for " + SITE_URL + "...");

try {
  execFileSync(
    "npx",
    ["--no", "--", "w2agent", "generate", SITE_URL, "--format", formats.join(","), "--no-platform", "--output", "./public/"],
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
  -> Writes llms.txt and llms-full.txt to the output directory, except a file public/ already has (overwrite: true replaces both; needs the w2agent CLI installed in your project)

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

The \`public/llms.txt\` and \`public/llms-full.txt\` copied in step 1 are w2agent output, so \`overwrite: true\` lets every build regenerate both. Plain \`w2agent()\` keeps every file that exists in \`public/\`, so with both seeds copied it refreshes nothing. To keep one of your own files and refresh the other, copy only the other seed in step 1 and list the file to refresh: \`w2agent({ overwrite: ["llms-full.txt"] })\` keeps your hand-written \`public/llms.txt\`, \`w2agent({ overwrite: ["llms.txt"] })\` keeps your own \`public/llms-full.txt\`. A file that is in \`public/\` and not listed is never replaced. Anything else as \`overwrite\` (not \`true\`, \`false\` or such a list) throws.

### Alternative: prebuild script
\`\`\`bash
cp astro/w2agent-build.mjs your-astro-app/
\`\`\`

Instead of the integration, \`w2agent-build.mjs\` can run as \`"prebuild": "node w2agent-build.mjs --overwrite"\` and writes into \`public/\`. Use one of the two, not both, or the site is crawled twice per build. The script keeps a file that already exists in \`public/\` and writes only the missing ones, so a plain run never refreshes the step 1 seeds. Pass \`--overwrite\` to replace both files on every run, or \`--overwrite=llms-full.txt\` (comma-separated names) to replace only those and keep your own \`public/llms.txt\`. Any other argument, including \`--overwrite llms-full.txt\` with a space, prints the valid forms and exits 1 before anything is generated.
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
