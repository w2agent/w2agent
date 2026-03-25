import type { Check } from "../audit/types.js";
import type { SiteType } from "./types.js";

export interface SiteTypeCheckAdapter {
  siteType: SiteType;
  checks: Check[];
}

const registry = new Map<SiteType, Check[]>();

export function registerSiteTypeChecks(adapter: SiteTypeCheckAdapter): void {
  const existing = registry.get(adapter.siteType) ?? [];
  registry.set(adapter.siteType, [...existing, ...adapter.checks]);
}

export function getSiteTypeChecks(siteType: SiteType): Check[] {
  return registry.get(siteType) ?? [];
}
