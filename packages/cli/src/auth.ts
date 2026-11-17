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

export function getAuthHeaders(): Record<string, string> {
  const creds = loadCredentials();
  if (!creds) return {};
  return { Authorization: `Bearer ${creds.token}` };
}

export function getApiUrl(): string {
  return process.env.W2AGENT_API_URL || "https://w2agent.dev";
}
