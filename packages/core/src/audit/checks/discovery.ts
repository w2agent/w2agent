import {
  fetchText,
  guardedFetch,
  type IsAllowedTarget,
  readBodyCapped,
} from "../../shared/fetcher.js";
import { parseHTML } from "../../shared/html-parser.js";
import { validateAgentCard } from "../shared/agent-card.js";
import { isJsonContentType, mediaTypeEssence, parseJsonObject } from "../shared/json.js";
import type { Check, CheckResult, SiteMetadata } from "../types.js";

export const llmsTxtExists: Check = {
  id: "llms-txt-exists",
  name: "llms.txt exists",
  category: "agent-discovery",
  weight: 0.5,
  severity: "warning",
  run: (_pages, metadata) => ({
    id: "llms-txt-exists",
    name: "llms.txt exists",
    category: "agent-discovery",
    status: metadata.llmsTxt ? "pass" : "fail",
    score: metadata.llmsTxt ? 100 : 0,
    maxScore: 100,
    weight: 0.5,
    message: metadata.llmsTxt
      ? "llms.txt found"
      : "No llms.txt found — coding agents and AI tools that read llms.txt have no curated index of your docs",
    severity: metadata.llmsTxt ? "info" : "warning",
    fixSnippet: !metadata.llmsTxt
      ? `# Create /llms.txt at your site root:\n# Your Site Name\n\n> Brief description of your site\n\n## Docs\n\n- [Page Title](https://yoursite.com/page): Description\n- [Another Page](https://yoursite.com/other): Description`
      : undefined,
  }),
};

export const llmsTxtValid: Check = {
  id: "llms-txt-valid",
  name: "llms.txt follows spec",
  category: "agent-discovery",
  weight: 0.5,
  severity: "info",
  run: (_pages, metadata) => {
    if (!metadata.llmsTxt) {
      return {
        id: "llms-txt-valid",
        name: "llms.txt follows spec",
        category: "agent-discovery",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 0.5,
        message: "No llms.txt to validate",
        severity: "info",
      };
    }

    const text = metadata.llmsTxt;
    let score = 0;

    // Has H1 title (line starting with #)
    if (/^#\s+.+/m.test(text)) score += 30;
    // Has blockquote description
    if (/^>\s+.+/m.test(text)) score += 20;
    // Has URL links
    if (/https?:\/\/\S+/.test(text)) score += 30;
    // Has section headers (##)
    if (/^##\s+.+/m.test(text)) score += 20;

    return {
      id: "llms-txt-valid",
      name: "llms.txt follows spec",
      category: "agent-discovery",
      status: score >= 70 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message:
        score >= 70
          ? "llms.txt follows the specification"
          : `llms.txt partially follows spec (${score}% complete)`,
      severity: "info",
    };
  },
};

export const llmsTxtLinksResolve: Check = {
  id: "llms-txt-links-resolve",
  name: "llms.txt links resolve",
  category: "agent-discovery",
  weight: 0.5,
  severity: "warning",
  run: async (_pages, metadata, ctx) => {
    if (!metadata.llmsTxt) {
      return {
        id: "llms-txt-links-resolve",
        name: "llms.txt links resolve",
        category: "agent-discovery",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 0.5,
        message: "No llms.txt to check links",
        severity: "info",
      };
    }

    const urlRegex = /https?:\/\/[^\s)>\],:]+/g;
    const urls = metadata.llmsTxt.match(urlRegex) || [];

    if (urls.length === 0) {
      return {
        id: "llms-txt-links-resolve",
        name: "llms.txt links resolve",
        category: "agent-discovery",
        status: "fail",
        score: 0,
        maxScore: 100,
        weight: 0.5,
        message: "No URLs found in llms.txt",
        severity: "warning",
      };
    }

    // Check up to 10 links
    const toCheck = urls.slice(0, 10);
    const results = await Promise.all(
      toCheck.map(async (url) => {
        const result = await fetchText(url, {
          timeout: 5000,
          userAgent: "w2agent/0.1",
          isAllowedTarget: ctx?.isAllowedTarget,
        });
        return { url, ok: result !== null && result.status >= 200 && result.status < 400 };
      }),
    );

    const resolved = results.filter((r) => r.ok).length;
    const score = Math.round((resolved / toCheck.length) * 100);

    return {
      id: "llms-txt-links-resolve",
      name: "llms.txt links resolve",
      category: "agent-discovery",
      status: score === 100 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message: `${resolved}/${toCheck.length} URLs in llms.txt resolve successfully`,
      details: results
        .filter((r) => !r.ok)
        .map((r) => `Broken: ${r.url}`)
        .join("\n"),
      severity: score < 100 ? "warning" : "info",
    };
  },
};

const AGENT_CARD_FIX_SNIPPET = `# Only if this site operates an A2A agent: publish /.well-known/agent-card.json (A2A v1.0).
# supportedInterfaces[].url must be the agent's live A2A endpoint, never the site homepage.
# Sites without an A2A agent should not publish a card.
# w2agent generate <site> --format agent-card --a2a-endpoint <your A2A endpoint URL>`;

function agentCardResult(
  status: CheckResult["status"],
  score: number,
  message: string,
): CheckResult {
  return {
    id: "well-known-agent-card",
    name: "/.well-known/agent-card.json",
    category: "agent-discovery",
    status,
    score,
    maxScore: 100,
    weight: 1,
    message,
    severity: "info",
    fixSnippet: status === "pass" ? undefined : AGENT_CARD_FIX_SNIPPET,
  };
}

export const wellKnownAgentCard: Check = {
  id: "well-known-agent-card",
  name: "/.well-known/agent-card.json",
  category: "agent-discovery",
  weight: 1,
  severity: "info",
  run: (_pages, metadata) => {
    const card = parseJsonObject(metadata.wellKnown["agent-card.json"]);
    if (!card) return agentCardResult("fail", 0, "No /.well-known/agent-card.json found");

    const { shape, missing, stubUrls } = validateAgentCard(card, metadata.baseUrl);
    const stub =
      stubUrls.length > 0
        ? `a stub: its interface URL ${stubUrls[0]} is the site homepage, not an A2A endpoint`
        : "";
    if (shape === "v1.0") {
      if (stub) return agentCardResult("partial", 50, `A2A v1.0 agent card is ${stub}`);
      return agentCardResult("pass", 100, `A2A v1.0 agent card: ${card.name}`);
    }
    if (shape === "v0.3") {
      const needs = `v1.0 requires ${missing.join(", ")}`;
      return agentCardResult(
        "partial",
        50,
        stub
          ? `A2A v0.3 agent card (top-level url) is ${stub}; ${needs}`
          : `A2A v0.3 agent card (top-level url); ${needs}`,
      );
    }
    return agentCardResult(
      "fail",
      0,
      `agent-card.json is not an A2A agent card — missing or invalid: ${missing.join(", ")}`,
    );
  },
};

const MCP_SERVER_CARD_TYPE = "application/mcp-server-card+json";
const MAX_CATALOG_ENTRIES = 3;
const SERVER_CARD_TIMEOUT_MS = 5000;
const SERVER_CARD_BUDGET_MS = 10000;
const MAX_SERVER_CARD_BYTES = 256 * 1024;
const SERVER_CARD_FIELDS = ["name", "version", "description"];

function serverCardResult(
  status: CheckResult["status"],
  score: number,
  message: string,
): CheckResult {
  return {
    id: "mcp-server-card",
    name: "MCP server card",
    category: "agent-discovery",
    status,
    score,
    maxScore: 100,
    weight: 0,
    message,
    severity: "info",
  };
}

async function fetchServerCard(
  url: string,
  deadline: number,
  isAllowedTarget?: IsAllowedTarget,
): Promise<string | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  try {
    const res = await guardedFetch(
      url,
      {
        headers: { Accept: "application/mcp-server-card+json, application/json;q=0.9" },
        signal: AbortSignal.timeout(Math.min(SERVER_CARD_TIMEOUT_MS, remaining)),
      },
      isAllowedTarget,
    );
    if (res.status !== 200 || !isJsonContentType(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    return await readBodyCapped(res, MAX_SERVER_CARD_BYTES);
  } catch {
    return undefined;
  }
}

function catalogServerCardUrls(metadata: SiteMetadata): string[] {
  const entries = parseJsonObject(metadata.wellKnown["ai-catalog.json"])?.entries;
  if (!Array.isArray(entries)) return [];
  const catalogUrl = `${metadata.baseUrl}/.well-known/ai-catalog.json`;
  const urls: string[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const { type, url } = entry as Record<string, unknown>;
    if (typeof type !== "string" || mediaTypeEssence(type) !== MCP_SERVER_CARD_TYPE) continue;
    if (typeof url !== "string") continue;
    try {
      const resolved = new URL(url, catalogUrl);
      if (resolved.protocol === "https:" || resolved.protocol === "http:") urls.push(resolved.href);
    } catch {}
  }
  return urls.slice(0, MAX_CATALOG_ENTRIES);
}

export async function findMcpServerCard(
  metadata: SiteMetadata,
  isAllowedTarget?: IsAllowedTarget,
  budgetMs = SERVER_CARD_BUDGET_MS,
): Promise<CheckResult> {
  const deadline = Date.now() + budgetMs;
  const siteOrigin = new URL(metadata.baseUrl).origin;
  const trusted = (url: string) => metadata.catchAll !== true || new URL(url).origin !== siteOrigin;
  const candidates: Array<{ where: string; load: () => Promise<string | undefined> }> = [];
  if (metadata.mcpEndpoint !== undefined) {
    const url = `${metadata.mcpEndpoint.replace(/\/+$/, "")}/server-card`;
    if (trusted(url)) {
      candidates.push({
        where: `${url} (MCP endpoint)`,
        load: () => fetchServerCard(url, deadline, isAllowedTarget),
      });
    }
  }
  for (const url of catalogServerCardUrls(metadata).filter(trusted)) {
    candidates.push({
      where: `${url} (ai-catalog.json entry)`,
      load: () => fetchServerCard(url, deadline, isAllowedTarget),
    });
  }
  candidates.push({
    where: "/.well-known/mcp/server-card.json (legacy)",
    load: async () => metadata.wellKnown["mcp/server-card.json"],
  });

  const invalid: string[] = [];
  for (const { where, load } of candidates) {
    const card = parseJsonObject(await load());
    if (!card) continue;
    const missing = SERVER_CARD_FIELDS.filter(
      (f) => typeof card[f] !== "string" || (card[f] as string).trim() === "",
    );
    if (missing.length === 0) {
      return serverCardResult(
        "pass",
        100,
        `MCP server card at ${where}: ${card.name} v${card.version}`,
      );
    }
    invalid.push(`${where} is missing ${missing.join(", ")}`);
  }
  if (invalid.length > 0) {
    return serverCardResult("fail", 0, `MCP server card found but invalid: ${invalid.join("; ")}`);
  }
  return serverCardResult(
    "skip",
    0,
    "No MCP server card (<MCP endpoint>/server-card, ai-catalog.json entry, or /.well-known/mcp/server-card.json)",
  );
}

export const mcpServerCard: Check = {
  id: "mcp-server-card",
  name: "MCP server card",
  category: "agent-discovery",
  weight: 0,
  severity: "info",
  tracked: true,
  run: (_pages, metadata, ctx) => findMcpServerCard(metadata, ctx?.isAllowedTarget),
};

const SKILLS_INDEX_KEY = "agent-skills/index.json";
const SKILLS_INDEX_PATH = "/.well-known/agent-skills/index.json";
const SKILLS_SCHEMA_V02 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const MAX_SKILLS_INDEX_BYTES = 256 * 1024;
const MAX_SKILL_PROBLEMS = 3;
const MAX_SKILL_DETAILS = 10;
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SKILL_TYPES = ["skill-md", "archive"];
const SKILLS_RFC_URL = "https://github.com/cloudflare/agent-skills-discovery-rfc";
const SKILLS_FIX_SNIPPET = `# Serve ${SKILLS_INDEX_PATH} as application/json (see ${SKILLS_RFC_URL}):
{
  "$schema": "${SKILLS_SCHEMA_V02}",
  "skills": [
    {
      "name": "my-skill",
      "type": "skill-md",
      "description": "What the skill does and when to use it",
      "url": "/.well-known/agent-skills/my-skill/SKILL.md",
      "digest": "sha256:<64 lowercase hex chars of the artifact>"
    }
  ]
}`;

function skillsResult(
  status: CheckResult["status"],
  score: number,
  message: string,
  details?: string[],
): CheckResult {
  return {
    id: "agent-skills-index",
    name: "Agent Skills index",
    category: "agent-discovery",
    status,
    score,
    maxScore: 100,
    weight: 0,
    message,
    severity: "info",
    tracked: true,
    ...(details && details.length > 0 ? { details: details.join("\n") } : {}),
    ...(status === "pass" || status === "skip" ? {} : { fixSnippet: SKILLS_FIX_SNIPPET }),
  };
}

function skillEntryProblems(entry: unknown, indexUrl: string): string[] {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return ["is not an object"];
  }
  const { name, type, description, url, digest } = entry as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof name !== "string" || name.length < 1 || name.length > 64) {
    problems.push("`name` is missing or not 1-64 characters");
  } else if (!SKILL_NAME_RE.test(name)) {
    problems.push("`name` must be lowercase alphanumeric words separated by single hyphens");
  }
  if (typeof type !== "string" || !SKILL_TYPES.includes(type)) {
    problems.push('`type` must be "skill-md" or "archive"');
  }
  if (
    typeof description !== "string" ||
    description.trim() === "" ||
    [...description].length > 1024
  ) {
    problems.push("`description` is missing, blank, or over 1024 characters");
  }
  if (typeof url !== "string" || url.trim() === "") {
    problems.push("`url` is missing or not a non-empty string");
  } else {
    try {
      const resolved = new URL(url, indexUrl);
      const self = new URL(indexUrl);
      resolved.hash = "";
      if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
        problems.push("`url` must resolve to an http(s) URL");
      } else if (resolved.href === self.href) {
        problems.push("`url` resolves to the index itself");
      }
    } catch {
      problems.push("`url` cannot be resolved against the index URL");
    }
  }
  if (typeof digest !== "string" || !SKILL_DIGEST_RE.test(digest)) {
    problems.push("`digest` must match sha256:<64 lowercase hex chars>");
  }
  return problems;
}

function skillsIndexProblems(skills: unknown[], indexUrl: string): string[] {
  const problems: string[] = [];
  skills.forEach((entry, i) => {
    const label =
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { name?: unknown }).name === "string"
        ? ` (${(entry as { name: string }).name.slice(0, 64)})`
        : "";
    for (const p of skillEntryProblems(entry, indexUrl)) {
      problems.push(`skills[${i}]${label}: ${p}`);
    }
  });
  return problems;
}

function summarizeProblems(problems: string[]): string {
  const shown = problems.slice(0, MAX_SKILL_PROBLEMS).join("; ");
  const more = problems.length - MAX_SKILL_PROBLEMS;
  return more > 0 ? `${shown} (+${more} more)` : shown;
}

export function evaluateSkillsIndex(raw: string | undefined, baseUrl: string): CheckResult {
  if (raw === undefined) {
    return skillsResult("skip", 0, `No Agent Skills index (${SKILLS_INDEX_PATH})`);
  }
  if (Buffer.byteLength(raw) > MAX_SKILLS_INDEX_BYTES) {
    return skillsResult(
      "fail",
      0,
      `Agent Skills index exceeds ${MAX_SKILLS_INDEX_BYTES / 1024} KB (${SKILLS_INDEX_PATH})`,
    );
  }
  const index = parseJsonObject(raw);
  if (!index) {
    return skillsResult("fail", 0, `${SKILLS_INDEX_PATH} is not a valid JSON object`);
  }
  const schema = index.$schema;
  const schemaAbsent = schema === undefined;
  if (!schemaAbsent && schema !== SKILLS_SCHEMA_V02) {
    return skillsResult(
      "fail",
      0,
      typeof schema === "string"
        ? `Agent Skills index $schema "${schema.slice(0, 200)}" is not the known ${SKILLS_SCHEMA_V02}; clients SHOULD NOT process it`
        : `Agent Skills index $schema is not a string; clients SHOULD NOT process it (expected ${SKILLS_SCHEMA_V02})`,
    );
  }
  const { skills } = index;
  if (!Array.isArray(skills)) {
    return skillsResult("fail", 0, "Agent Skills index `skills` is missing or not an array");
  }
  if (skills.length === 0) {
    return skillsResult("fail", 0, "Agent Skills index lists no skills");
  }
  const problems = skillsIndexProblems(skills, `${baseUrl}${SKILLS_INDEX_PATH}`);
  if (schemaAbsent) problems.unshift("$schema missing");
  if (problems.length > 0 && !(schemaAbsent && problems.length === 1)) {
    return skillsResult("fail", 0, `Agent Skills index invalid: ${summarizeProblems(problems)}`);
  }
  const details = (skills as Array<{ name: string; type: string }>)
    .slice(0, MAX_SKILL_DETAILS)
    .map((s) => `${s.name} (${s.type})`);
  if (schemaAbsent) {
    return skillsResult(
      "partial",
      50,
      `Agent Skills index lists ${skills.length} skill(s) but has no $schema, which v0.2.0 requires; clients will treat it as v0.1.0`,
      details,
    );
  }
  return skillsResult("pass", 100, `Agent Skills index lists ${skills.length} skill(s)`, details);
}

export const agentSkillsIndex: Check = {
  id: "agent-skills-index",
  name: "Agent Skills index",
  category: "agent-discovery",
  weight: 0,
  severity: "info",
  tracked: true,
  run: (_pages, metadata) =>
    evaluateSkillsIndex(metadata.wellKnown[SKILLS_INDEX_KEY], metadata.baseUrl),
};

export const markdownAlternate: Check = {
  id: "markdown-alternate",
  name: "Markdown alternate links",
  category: "agent-discovery",
  weight: 0.5,
  severity: "info",
  run: (pages) => {
    let pagesWithAlt = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const hasMarkdownAlt = parsed.alternateLinks.some((link) => link.type.includes("markdown"));
      if (hasMarkdownAlt) pagesWithAlt++;
    }

    const score = pagesWithAlt > 0 ? Math.min(100, pagesWithAlt * 25) : 0;

    return {
      id: "markdown-alternate",
      name: "Markdown alternate links",
      category: "agent-discovery",
      status: score > 0 ? "pass" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message:
        pagesWithAlt > 0
          ? `${pagesWithAlt} page(s) have markdown alternate links`
          : "No markdown alternate links found",
      severity: "info",
      fixSnippet:
        pagesWithAlt === 0
          ? `<!-- Add to <head> -->\n<link rel="alternate" type="text/markdown" href="/page.md" />`
          : undefined,
    };
  },
};

export const discoveryChecks: Check[] = [
  llmsTxtExists,
  llmsTxtValid,
  llmsTxtLinksResolve,
  wellKnownAgentCard,
  mcpServerCard,
  agentSkillsIndex,
  markdownAlternate,
];
