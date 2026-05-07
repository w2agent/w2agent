import type { Check, CheckResult } from "../types.js";

function res(
  id: string,
  name: string,
  status: CheckResult["status"],
  score: number,
  message: string,
): CheckResult {
  return { id, name, category: "agent-protocols", status, score, maxScore: 100, weight: 1, message, severity: "info" };
}

function makeSimCheck(
  id: string,
  name: string,
  uaKey: string,
  expectations: (html: string, meta: import("../types.js").SiteMetadata) => boolean,
): Check {
  return {
    id,
    name,
    category: "agent-protocols",
    weight: 1,
    severity: "info",
    run: (pages, metadata) => {
      const resp = metadata.multiUaResponses?.[uaKey];
      if (!resp) {
        return res(id, name, "skip", 0, "No multi-UA simulation data available");
      }
      if (!resp.reachable) {
        return res(id, name, "fail", 0, `${uaKey} cannot reach the homepage (status=${resp.status})`);
      }
      const pageHtml = pages[0]?.html ?? "";
      if (expectations(pageHtml, metadata)) {
        return res(id, name, "pass", 100, `${uaKey} can reach and use the site`);
      }
      return res(id, name, "partial", 50, `${uaKey} can reach but missing per-agent expectations`);
    },
  };
}

const simClaude = makeSimCheck("sim-claude", "Claude can use this site", "claude", (_html, meta) => {
  return !!(meta.llmsTxt || meta.openapi || meta.mcpInit?.success);
});

const simChatgpt = makeSimCheck("sim-chatgpt", "ChatGPT can use this site", "chatgpt", (_html, meta) => {
  return !!(meta.openapi || meta.wellKnown?.["ai-plugin.json"]);
});

const simGemini = makeSimCheck("sim-gemini", "Gemini can use this site", "gemini", (html, _meta) => {
  return /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
});

const simPerplexity = makeSimCheck(
  "sim-perplexity",
  "Perplexity can use this site",
  "perplexity",
  (_html, meta) => {
    return (meta.multiUaResponses?.perplexity?.contentLength ?? 0) > 1000;
  },
);

// DeepSeek expectations are reachability-only for now — no DeepSeek-specific
// signals are well-defined yet. The `partial` status path is unreachable for
// this check; future iterations may add bot-policy detection or content checks.
const simDeepseek = makeSimCheck("sim-deepseek", "DeepSeek can use this site", "deepseek", () => {
  return true;
});

export const multiUaSimChecks: Check[] = [simClaude, simChatgpt, simGemini, simPerplexity, simDeepseek];
export { simClaude, simChatgpt, simGemini, simPerplexity, simDeepseek };
