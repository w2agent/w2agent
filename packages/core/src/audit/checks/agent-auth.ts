import type { Check } from "../types.js";

export const agentAuthChecks: Check[] = [
  {
    id: "agent-auth-placeholder",
    name: "Auth & Access",
    category: "agent-auth",
    weight: 1,
    severity: "info",
    run: () => ({
      id: "agent-auth-placeholder",
      name: "Auth & Access",
      category: "agent-auth",
      status: "skip",
      score: 0,
      maxScore: 100,
      weight: 1,
      message: "Auth & Access checks not yet implemented",
      severity: "info",
    }),
  },
];
