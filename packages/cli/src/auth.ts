import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
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
  mkdirSync(dirname(configPath), { recursive: true });
  const creds: Credentials = {
    token,
    email,
    created: new Date().toISOString(),
  };
  writeFileSync(configPath, JSON.stringify(creds, null, 2), "utf-8");
  chmod(configPath, 0o600).catch(() => {});
}

export function clearCredentials(): void {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    rmSync(configPath);
  }
}

export function getAuthHeaders(): Record<string, string> {
  const creds = loadCredentials();
  if (!creds) return {};
  return { Authorization: `Bearer ${creds.token}` };
}

export function getApiUrl(): string {
  return process.env.W2AGENT_API_URL || "https://w2agent.dev";
}
