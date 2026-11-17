import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { detectAstroLayout, resolveAstroInstall } from "../src/adapters/astro/install.js";
import {
  detectDocusaurusLayout,
  resolveDocusaurusInstall,
} from "../src/adapters/docusaurus/install.js";
import { detectNextjsLayout, resolveNextjsInstall } from "../src/adapters/nextjs/install.js";
import { detectNuxtLayout, resolveNuxtInstall } from "../src/adapters/nuxt/install.js";
import { detectShopifyLayout, resolveShopifyInstall } from "../src/adapters/shopify/install.js";
import {
  detectWordPressLayout,
  resolveWordPressInstall,
} from "../src/adapters/wordpress/install.js";
import type { GeneratedFile } from "../src/generate/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

// Simulated generated files for each platform
const PLATFORM_FILES: Record<string, GeneratedFile[]> = {
  nextjs: [
    makeFile("llms.txt", "# LLMs"),
    makeFile("llms-full.txt", "# Full"),
    makeFile("nextjs/middleware.ts", "export function middleware() {}"),
    makeFile("nextjs/app/llms.txt/route.ts", "export async function GET() {}"),
    makeFile("nextjs/app/llms-full.txt/route.ts", "export async function GET() {}"),
    makeFile("nextjs/app/.well-known/agent-card.json/route.ts", "export async function GET() {}"),
    makeFile("nextjs/public/llms.txt", "# Seed"),
    makeFile("nextjs/public/llms-full.txt", "# Seed Full"),
    makeFile("nextjs/w2agent-build.mjs", "// build"),
    makeFile("nextjs/INSTALL.md", "# Install"),
  ],
  nuxt: [
    makeFile("llms.txt", "# LLMs"),
    makeFile("nuxt/server/routes/llms.txt.ts", "export default defineEventHandler(() => {})"),
    makeFile("nuxt/server/routes/llms-full.txt.ts", "export default defineEventHandler(() => {})"),
    makeFile(
      "nuxt/server/routes/.well-known/agent-card.json.ts",
      "export default defineEventHandler(() => {})",
    ),
    makeFile(
      "nuxt/server/middleware/content-negotiation.ts",
      "export default defineEventHandler(() => {})",
    ),
    makeFile("nuxt/public/llms.txt", "# Seed"),
    makeFile("nuxt/public/llms-full.txt", "# Seed Full"),
    makeFile("nuxt/w2agent-build.mjs", "// build"),
    makeFile("nuxt/INSTALL.md", "# Install"),
  ],
  astro: [
    makeFile("astro/public/llms.txt", "# Seed"),
    makeFile("astro/public/llms-full.txt", "# Seed Full"),
    makeFile("astro/public/.well-known/agent-card.json", "{}"),
    makeFile("astro/src/pages/llms.txt.ts", "export const GET = () => {}"),
    makeFile("astro/src/pages/.well-known/agent-card.json.ts", "export const GET = () => {}"),
    makeFile("astro/w2agent-integration.mjs", "// integration"),
    makeFile("astro/w2agent-build.mjs", "// build"),
    makeFile("astro/INSTALL.md", "# Install"),
  ],
  docusaurus: [
    makeFile("docusaurus/w2agent-plugin.js", "module.exports = function() {}"),
    makeFile("docusaurus/static/llms.txt", "# Seed"),
    makeFile("docusaurus/static/.well-known/agent-card.json", "{}"),
    makeFile("docusaurus/INSTALL.md", "# Install"),
  ],
  wordpress: [
    makeFile("wordpress/w2agent-plugin.php", "<?php /* Plugin */"),
    makeFile("wordpress/data/llms.txt", "# LLMs"),
    makeFile("wordpress/data/agent-card.json", "{}"),
    makeFile("wordpress/INSTALL.md", "# Install"),
  ],
  shopify: [
    makeFile("shopify/snippets/w2agent-head.liquid", "{% comment %}w2agent{% endcomment %}"),
    makeFile("shopify/data/llms.txt", "# LLMs"),
    makeFile("shopify/data/robots-txt-additions.txt", "# additions"),
    makeFile("shopify/INSTALL.md", "# Install"),
  ],
};

type ResolverFn = (files: GeneratedFile[], dir: string) => any;
type DetectorFn = (dir: string) => any;

const RESOLVERS: Record<string, ResolverFn> = {
  nextjs: resolveNextjsInstall,
  nuxt: resolveNuxtInstall,
  astro: resolveAstroInstall,
  docusaurus: resolveDocusaurusInstall,
  wordpress: resolveWordPressInstall,
  shopify: resolveShopifyInstall,
};

const DETECTORS: Record<string, DetectorFn> = {
  nextjs: detectNextjsLayout,
  nuxt: detectNuxtLayout,
  astro: detectAstroLayout,
  docusaurus: detectDocusaurusLayout,
  wordpress: detectWordPressLayout,
  shopify: detectShopifyLayout,
};

const REPO_DIR = "/tmp/w2agent-real-repo-test/repos";

interface TestResult {
  repo: string;
  platform: string;
  status: "pass" | "fail" | "warn";
  layout: any;
  writes: number;
  skips: number;
  manuals: number;
  warnings: string[];
  postSteps: string[];
  error?: string;
}

function testRepo(platform: string, repoName: string): TestResult {
  const repoDir = join(REPO_DIR, platform, repoName);

  // Some repos have their actual project in a subdirectory — detect common patterns
  let projectDir = repoDir;

  // For monorepos, try to find the actual project dir
  if (platform === "nextjs") {
    // cal.com has apps/web, taxonomy is root, next.js has examples
    for (const sub of ["apps/web", "apps/dashboard", "."]) {
      const candidate = join(repoDir, sub);
      if (
        existsSync(join(candidate, "app")) ||
        existsSync(join(candidate, "src", "app")) ||
        existsSync(join(candidate, "pages"))
      ) {
        projectDir = candidate;
        break;
      }
    }
  } else if (platform === "nuxt") {
    for (const sub of [".", "packages/nuxt", "src"]) {
      const candidate = join(repoDir, sub);
      if (
        existsSync(join(candidate, "nuxt.config.ts")) ||
        existsSync(join(candidate, "nuxt.config.js"))
      ) {
        projectDir = candidate;
        break;
      }
    }
  } else if (platform === "docusaurus") {
    for (const sub of ["website", "docs", "."]) {
      const candidate = join(repoDir, sub);
      if (
        existsSync(join(candidate, "docusaurus.config.js")) ||
        existsSync(join(candidate, "docusaurus.config.ts"))
      ) {
        projectDir = candidate;
        break;
      }
    }
  }

  try {
    const detector = DETECTORS[platform];
    const resolver = RESOLVERS[platform];
    const files = PLATFORM_FILES[platform];

    const layout = detector(projectDir);
    const plan = resolver(files, projectDir);

    const writes = plan.actions.filter((a: any) => a.type === "write").length;
    const skips = plan.actions.filter((a: any) => a.type === "skip").length;
    const manuals = plan.actions.filter((a: any) => a.type === "manual").length;

    const status = plan.warnings.length > 0 ? "warn" : "pass";

    return {
      repo: repoName,
      platform,
      status,
      layout,
      writes,
      skips,
      manuals,
      warnings: plan.warnings,
      postSteps: plan.postInstallSteps,
    };
  } catch (err: any) {
    return {
      repo: repoName,
      platform,
      status: "fail",
      layout: null,
      writes: 0,
      skips: 0,
      manuals: 0,
      warnings: [],
      postSteps: [],
      error: err.message,
    };
  }
}

// Main
const platforms = readdirSync(REPO_DIR).filter((d) => existsSync(join(REPO_DIR, d)));
const allResults: TestResult[] = [];

for (const platform of platforms) {
  const platformDir = join(REPO_DIR, platform);
  if (!existsSync(platformDir)) continue;

  const repos = readdirSync(platformDir);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Platform: ${platform.toUpperCase()} (${repos.length} repos)`);
  console.log(`${"=".repeat(60)}`);

  for (const repo of repos) {
    const result = testRepo(platform, repo);
    allResults.push(result);

    const icon = result.status === "pass" ? "✅" : result.status === "warn" ? "⚠️" : "❌";
    console.log(`\n${icon} ${platform}/${repo}`);
    console.log(`   Layout: ${JSON.stringify(result.layout, null, 0)}`);
    console.log(
      `   Actions: ${result.writes} write, ${result.skips} skip, ${result.manuals} manual`,
    );
    if (result.warnings.length > 0) {
      for (const w of result.warnings) console.log(`   ⚠ ${w}`);
    }
    if (result.postSteps.length > 0) {
      for (const s of result.postSteps) console.log(`   📋 ${s}`);
    }
    if (result.error) {
      console.log(`   ❌ Error: ${result.error}`);
    }
  }
}

// Summary
console.log(`\n${"=".repeat(60)}`);
console.log("SUMMARY");
console.log(`${"=".repeat(60)}`);

for (const platform of platforms) {
  const results = allResults.filter((r) => r.platform === platform);
  const pass = results.filter((r) => r.status === "pass").length;
  const warn = results.filter((r) => r.status === "warn").length;
  const fail = results.filter((r) => r.status === "fail").length;
  console.log(`${platform}: ${pass} pass, ${warn} warn, ${fail} fail (${results.length} total)`);
}

const total = allResults.length;
const totalPass = allResults.filter((r) => r.status === "pass").length;
const totalWarn = allResults.filter((r) => r.status === "warn").length;
const totalFail = allResults.filter((r) => r.status === "fail").length;
console.log(`\nTotal: ${totalPass} pass, ${totalWarn} warn, ${totalFail} fail (${total} repos)`);
