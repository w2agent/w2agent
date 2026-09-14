export type AgentCardShape = "v1.0" | "v0.3" | "none";

export interface AgentCardValidation {
  shape: AgentCardShape;
  missing: string[];
  stubUrls: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isSiteRoot(url: string, siteOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === siteOrigin && parsed.pathname === "/";
  } catch {
    return false;
  }
}

function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isInterface(value: unknown): boolean {
  return (
    isObject(value) &&
    isAbsoluteHttpUrl(value.url) &&
    isText(value.protocolBinding) &&
    isText(value.protocolVersion)
  );
}

function isSkill(value: unknown): boolean {
  return (
    isObject(value) &&
    isText(value.id) &&
    isText(value.name) &&
    isText(value.description) &&
    isStringArray(value.tags)
  );
}

function missingV1Fields(card: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const field of ["name", "description", "version"]) {
    if (!isText(card[field])) missing.push(field);
  }
  const interfaces = card.supportedInterfaces;
  if (!Array.isArray(interfaces) || interfaces.length === 0 || !interfaces.every(isInterface)) {
    missing.push("supportedInterfaces[] {absolute url, protocolBinding, protocolVersion}");
  }
  if (!isObject(card.capabilities)) missing.push("capabilities");
  if (!isStringArray(card.defaultInputModes)) missing.push("defaultInputModes");
  if (!isStringArray(card.defaultOutputModes)) missing.push("defaultOutputModes");
  if (!Array.isArray(card.skills) || !card.skills.every(isSkill)) {
    missing.push("skills[] {id, name, description, tags}");
  }
  return missing;
}

export function validateAgentCard(card: unknown, baseUrl: string): AgentCardValidation {
  const siteOrigin = new URL(baseUrl).origin;
  if (!isObject(card)) {
    return { shape: "none", missing: missingV1Fields({}), stubUrls: [] };
  }
  const missing = missingV1Fields(card);
  if (missing.length === 0) {
    const urls = (card.supportedInterfaces as Array<{ url: string }>).map((i) => i.url);
    return { shape: "v1.0", missing, stubUrls: urls.filter((u) => isSiteRoot(u, siteOrigin)) };
  }
  if (
    isText(card.name) &&
    isAbsoluteHttpUrl(card.url) &&
    (isText(card.preferredTransport) || (isObject(card.capabilities) && Array.isArray(card.skills)))
  ) {
    return {
      shape: "v0.3",
      missing,
      stubUrls: isSiteRoot(card.url, siteOrigin) ? [card.url] : [],
    };
  }
  return { shape: "none", missing, stubUrls: [] };
}
