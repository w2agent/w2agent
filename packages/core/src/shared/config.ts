import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import type { AuditOptions, CategoryId } from "../audit/types.js";

export interface W2AgentConfig {
  audit?: {
    maxPages?: number;
    timeout?: number;
    categories?: CategoryId[];
    verbose?: boolean;
    userAgent?: string;
  };
}

export function loadConfig(dir: string = process.cwd()): W2AgentConfig | null {
  const names = ["w2agent.config.yaml", "w2agent.config.yml", ".w2agent.yaml"];
  for (const name of names) {
    try {
      const content = readFileSync(resolve(dir, name), "utf-8");
      return YAML.parse(content) as W2AgentConfig;
    } catch {}
  }
  return null;
}

export function mergeConfigWithOptions(
  config: W2AgentConfig | null,
  cliOptions: Partial<AuditOptions>,
): Partial<AuditOptions> {
  const configAudit = config?.audit ?? {};
  return {
    ...configAudit,
    ...cliOptions,
  };
}
