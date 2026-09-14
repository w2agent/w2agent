export function mediaTypeEssence(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

export function isJsonContentType(contentType: string): boolean {
  const essence = mediaTypeEssence(contentType);
  return essence === "application/json" || /^[^/\s]+\/[^/\s]+\+json$/.test(essence);
}

export function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isAgentCard(raw: string | undefined): boolean {
  const name = parseJsonObject(raw)?.name;
  return typeof name === "string" && name.trim() !== "";
}
