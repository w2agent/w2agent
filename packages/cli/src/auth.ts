import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface Credentials {
  token: string;
  email?: string;
  created: string;
}

export function getConfigPath(): string {
  return join(homedir(), ".w2agent", "config.json");
}

export function loadCredentials(): { token: string; email?: string } | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Credentials;
    if (!parsed.token) return null;
    return { token: parsed.token, email: parsed.email };
  } catch {
    return null;
  }
}

export function saveCredentials(token: string, email?: string): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const creds: Credentials = {
    token,
    email,
    created: new Date().toISOString(),
  };
  const tmpPath = `${configPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(creds, null, 2), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(tmpPath, configPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export function clearCredentials(): void {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    rmSync(configPath);
  }
}

export function isHeaderSafeToken(token: string): boolean {
  return /^[\x21-\x7e]+$/.test(token);
}

export function getAuthHeaders(): Record<string, string> {
  const creds = loadCredentials();
  if (!creds) return {};
  return { Authorization: `Bearer ${creds.token}` };
}

const DEFAULT_API_URL = "https://w2agent.dev";

const API_URL_RULE = "W2AGENT_API_URL must be an https URL, or an http URL on localhost.";

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

export type ApiUrlResult = { ok: true; url: string } | { ok: false; message: string };

/** Decides by the parsed hostname; the message never echoes the raw value (it may hold userinfo). */
export function parseApiUrl(raw: string | undefined): ApiUrlResult {
  if (raw === undefined || raw === "") return { ok: true, url: DEFAULT_API_URL };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: `${API_URL_RULE} The value is not a valid URL.` };
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  const allowed =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname));
  if (!allowed || parsed.hostname === "") {
    const where = parsed.hostname ? ` on host ${parsed.hostname}` : "";
    return { ok: false, message: `${API_URL_RULE} Refusing ${scheme}${where}.` };
  }
  return { ok: true, url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}` };
}

/** The reason the configured API URL is refused, or undefined when it is usable. */
export function apiUrlProblem(): string | undefined {
  const result = parseApiUrl(process.env.W2AGENT_API_URL);
  return result.ok ? undefined : result.message;
}

export function getApiUrl(): string {
  const result = parseApiUrl(process.env.W2AGENT_API_URL);
  if (!result.ok) throw new Error(result.message);
  return result.url;
}
