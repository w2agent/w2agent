import type { Check, CheckResult } from "../types.js";

function res(
  id: string,
  name: string,
  status: CheckResult["status"],
  score: number,
  message: string,
): CheckResult {
  return {
    id,
    name,
    category: "agent-protocols",
    status,
    score,
    maxScore: 100,
    weight: 0.5,
    message,
    severity: "info",
  };
}

function makeReachCheck(id: string, token: string, uaKey: string): Check {
  const name = `Reachable as ${token}`;
  return {
    id,
    name,
    category: "agent-protocols",
    weight: 0.5,
    severity: "info",
    run: (_pages, metadata) => {
      const resp = metadata.multiUaResponses?.[uaKey];
      if (!resp) {
        return res(id, name, "error", 0, `Unmeasured — no ${token} fetch was recorded`);
      }
      if (resp.outcome === "budget-skipped") {
        return res(
          id,
          name,
          "error",
          0,
          "Unmeasured — crawler time budget exhausted before this user-agent was fetched",
        );
      }
      if (resp.outcome !== "ok") {
        return res(id, name, "fail", 0, `Homepage fetch as ${token} failed (${resp.outcome})`);
      }
      if (resp.status < 200 || resp.status >= 300) {
        return res(id, name, "fail", 0, `Homepage returned HTTP ${resp.status} to ${token}`);
      }
      if (resp.contentLength === 0) {
        return res(id, name, "fail", 0, `Homepage returned an empty body to ${token}`);
      }
      return res(id, name, "pass", 100, `Homepage returned HTTP ${resp.status} to ${token}`);
    },
  };
}

export const reachOpenai = makeReachCheck("reach-openai-user-agent", "ChatGPT-User", "openai");
export const reachPerplexity = makeReachCheck(
  "reach-perplexity-user-agent",
  "Perplexity-User",
  "perplexity",
);
export const reachGoogle = makeReachCheck("reach-google-user-agent", "Google-Agent", "google");

export const reachChecks: Check[] = [reachOpenai, reachPerplexity, reachGoogle];
