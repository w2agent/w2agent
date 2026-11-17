import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { GeneratedFile, InstallPlan, PlatformId } from "w2agent-core";

export const VALID_PLATFORMS: readonly PlatformId[] = [
  "wordpress",
  "nextjs",
  "shopify",
  "docusaurus",
  "nuxt",
  "astro",
];

export const JS_PLATFORMS: readonly PlatformId[] = ["nextjs", "nuxt", "astro", "docusaurus"];

export type ChangeAction = "create" | "modify" | "skip" | "manual" | "delete";

export interface PlannedChange {
  action: ChangeAction;
  path: string;
  reason: string;
}

export function mapPlanChanges(plan: InstallPlan, projectDir: string): PlannedChange[] {
  return plan.actions.map((a) => {
    const abs = resolve(projectDir, a.dest);
    const path = relative(projectDir, abs) || a.dest;
    switch (a.type) {
      case "write": {
        const exists = existsSync(abs);
        return {
          action: exists ? "modify" : "create",
          path,
          reason: a.reason ?? (exists ? "existing file will be overwritten" : "new file"),
        };
      }
      case "skip":
        return { action: "skip", path, reason: a.reason ?? "not needed" };
      case "manual":
        return { action: "manual", path, reason: a.reason ?? "manual step required" };
      default:
        return { action: "delete", path, reason: a.reason ?? "file will be deleted" };
    }
  });
}

/** The command that applies a dry run: same argv with --dry-run swapped for --install. */
export function applyArgv(argv: readonly string[]): string[] {
  const end = argv.indexOf("--");
  const head = end === -1 ? argv : argv.slice(0, end);
  const tail = end === -1 ? [] : argv.slice(end);
  const hasInstall = head.includes("--install");
  const out: string[] = [];
  for (const arg of head) {
    if (arg === "--dry-run") {
      if (!hasInstall) out.push("--install");
    } else {
      out.push(arg);
    }
  }
  return [...out, ...tail];
}

/** The dry-run form of a generate-to-directory command. */
export function dryRunArgv(argv: readonly string[]): string[] {
  const end = argv.indexOf("--");
  const head = end === -1 ? argv : argv.slice(0, end);
  const tail = end === -1 ? [] : argv.slice(end);
  const out: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const arg = head[i];
    if (arg === "-o" || arg === "--output") {
      i++;
    } else if (!arg.startsWith("--output=") && !(arg.startsWith("-o") && arg.length > 2)) {
      out.push(arg);
    }
  }
  if (!out.includes("--dry-run")) out.push("--dry-run");
  return [...out, ...tail];
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// Matches the plain and JSON-escaped (`http:\/\/`) spellings of a base string.
function slashTolerant(base: string): string {
  return escapeRegExp(base).replace(/\\\//g, "\\\\?/");
}

const AFTER_HOST_PORT = "(?![A-Za-z0-9_@-]|:\\d|\\.[A-Za-z0-9-])";

interface Rule {
  re: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

interface Authority {
  protocol: string;
  hostname: string;
  port: string;
}

function hostPortVariants(a: Authority): string[] {
  if (a.port !== "") return [`${a.hostname}:${a.port}`];
  const def = DEFAULT_PORTS[a.protocol];
  return def ? [`${a.hostname}:${def}`] : [];
}

function originVariants(a: Authority): string[] {
  const bare = `${a.protocol}//${a.hostname}${a.port ? `:${a.port}` : ""}`;
  const def = DEFAULT_PORTS[a.protocol];
  return a.port === "" && def ? [`${bare}:${def}`, bare] : [bare];
}

function rulesFor(a: Authority, site: URL, includeBare: boolean): Rule[] {
  const escapedSite = site.origin.replace(/\//g, "\\/");
  const encodedSite = encodeURIComponent(site.origin);
  const origins = originVariants(a);
  const originPattern = [
    ...origins.map(slashTolerant),
    ...origins.map((o) => escapeRegExp(encodeURIComponent(o))),
  ].join("|");
  const rules: Rule[] = [
    {
      re: new RegExp(`(?<![A-Za-z0-9])(?:${originPattern})${AFTER_HOST_PORT}`, "gi"),
      replace: (m) =>
        m.includes("%") ? encodedSite : m.includes("\\") ? escapedSite : site.origin,
    },
  ];
  const hostPorts = hostPortVariants(a);
  if (hostPorts.length > 0) {
    rules.push({
      re: new RegExp(
        `(?<![A-Za-z0-9.-])(?:${hostPorts.map(escapeRegExp).join("|")})${AFTER_HOST_PORT}`,
        "gi",
      ),
      replace: () => site.host,
    });
  }
  if (includeBare && a.hostname !== site.hostname) {
    const bare = escapeRegExp(a.hostname);
    // Only a whole derived value: a line that is just the host (optionally a
    // Markdown heading) or a quoted string that is just the host.
    rules.push(
      {
        re: new RegExp(`^([ \\t]*(?:#{1,6}[ \\t]+)?)${bare}(?=[ \\t\\r]*$)`, "gim"),
        replace: (_m, lead) => `${lead}${site.hostname}`,
      },
      { re: new RegExp(`(?<=")${bare}(?=")`, "gi"), replace: () => site.hostname },
    );
  }
  return rules;
}

/**
 * Rewrites the crawl origin and `host:port` to the site's in every file. Matches
 * end at a real boundary: `localhost:3000` is not found inside `localhost:30001`,
 * `localhost:3000.evil.com`, `mylocalhost` or `127.0.0.10`. When the crawl host
 * is a loopback name, the other loopback names on the same port are rewritten
 * too. The bare crawl hostname is rewritten only where it is a whole derived
 * value (core falls back to it as the site name): a line that is just the host
 * or `# host`, and a string value that is exactly `"host"`. Prose that merely
 * mentions it stays as written. Anything left that still names the crawl host
 * is reported in `warnings`.
 */
export function rewriteOrigin(
  files: GeneratedFile[],
  crawlUrl: string,
  siteUrl: string,
): { files: GeneratedFile[]; warnings: string[] } {
  const crawl = new URL(crawlUrl);
  const site = new URL(siteUrl);
  if (crawl.origin === site.origin) return { files, warnings: [] };

  const sameHost = crawl.host === site.host;
  const rules = rulesFor(crawl, site, !sameHost);
  if (!sameHost && LOOPBACK_HOSTS.includes(crawl.hostname)) {
    for (const alias of LOOPBACK_HOSTS) {
      if (alias !== crawl.hostname) {
        rules.push(
          ...rulesFor({ protocol: crawl.protocol, port: crawl.port, hostname: alias }, site, false),
        );
      }
    }
  }

  const rewritten = files.map((file) => {
    let content = file.content;
    for (const rule of rules) content = content.replace(rule.re, rule.replace);
    return content === file.content
      ? file
      : { ...file, content, size: Buffer.byteLength(content, "utf-8") };
  });

  const warnings: string[] = [];
  if (!sameHost) {
    const names = [crawl.hostname];
    if (LOOPBACK_HOSTS.includes(crawl.hostname)) {
      for (const alias of LOOPBACK_HOSTS) {
        if (alias !== crawl.hostname)
          names.push(
            ...hostPortVariants({ protocol: crawl.protocol, port: crawl.port, hostname: alias }),
          );
      }
    }
    const residueRe = new RegExp(
      `(?<![A-Za-z0-9.-])(?:${names.map(escapeRegExp).join("|")})(?![A-Za-z0-9_@-]|\\.[A-Za-z0-9-]|:\\d+\\.[A-Za-z0-9-])`,
      "i",
    );
    const residue = rewritten.filter((f) => residueRe.test(f.content)).map((f) => f.filename);
    if (residue.length > 0) {
      warnings.push(
        `Crawl host "${crawl.hostname}" still appears in generated content after --site-url rewrite: ${residue.join(", ")}`,
      );
    }
  }
  return { files: rewritten, warnings };
}
