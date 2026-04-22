const PRIVATE_IPV4_PATTERNS: RegExp[] = [
  /^127\./, // loopback
  /^0\./, // "this" network
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^169\.254\./, // link-local / cloud metadata
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // RFC1918 172.16/12
];

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "ip6-localhost" || host === "ip6-loopback") return true;

  if (PRIVATE_IPV4_PATTERNS.some((re) => re.test(host))) return true;

  // IPv6 loopback / link-local / unique-local
  if (host === "::1" || host === "::") return true;
  if (host.startsWith("fe80:") || host.startsWith("fe80::")) return true;
  if (host.startsWith("fc") || host.startsWith("fd")) {
    // fc00::/7 — ULA (both fc and fd high-bytes)
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
  }

  return false;
}

export function isOriginAllowed(
  url: string,
  baseOrigin: string,
  allowedHosts: string[] = [],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (isPrivateHost(parsed.hostname)) return false;
  if (parsed.origin === baseOrigin) return true;
  return allowedHosts.includes(parsed.hostname);
}
