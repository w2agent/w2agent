import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MIN_SECRET_LEN = 16;

function readJson(file, what) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${what} at ${file}: ${e.code ?? "read error"}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${what} at ${file} is not valid JSON`);
  }
}

function keychainRead() {
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    {
      encoding: "utf8",
    },
  );
  if (r.status !== 0) {
    throw new Error(
      "no Claude login found in the macOS Keychain; run `claude` on the host to log in or pass --claude-credentials <file>",
    );
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error("the Keychain entry for the Claude login is not valid JSON");
  }
}

export function readClaudeLogin({
  file,
  env = process.env,
  platform = process.platform,
  keychain = keychainRead,
} = {}) {
  if (file) return readJson(file, "Claude credentials");
  if (env.CLAUDE_CONFIG_DIR) {
    if (platform === "darwin") {
      const f = path.join(env.CLAUDE_CONFIG_DIR, ".credentials.json");
      try {
        return readJson(f, "Claude credentials");
      } catch {
        throw new Error(
          "CLAUDE_CONFIG_DIR is set on macOS: its Keychain entry has a hashed name this tool cannot derive; pass --claude-credentials <file>",
        );
      }
    }
    return readJson(path.join(env.CLAUDE_CONFIG_DIR, ".credentials.json"), "Claude credentials");
  }
  if (platform !== "darwin")
    return readJson(path.join(homedir(), ".claude", ".credentials.json"), "Claude credentials");
  return keychain();
}

export function stageClaude(json, { minValidMs = 0, now = Date.now() } = {}) {
  const oauth = json?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) {
    throw new Error(
      "Claude login has no access token; run `claude` on the host to log in, then retry",
    );
  }
  if (typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt)) {
    throw new Error(
      "Claude login has no valid expiresAt; run `claude` on the host to refresh the login, then retry",
    );
  }
  const left = oauth.expiresAt - now;
  if (!(left >= minValidMs)) {
    throw new Error(
      `Claude access token expires in ${Math.max(0, Math.round(left / 60000))} min, less than the ${Math.ceil(minValidMs / 60000)} min needed; run \`claude\` on the host to refresh the login, then retry`,
    );
  }
  const { refreshToken: _r, refreshTokenExpiresAt: _e, ...rest } = oauth;
  return { claudeAiOauth: rest };
}

export function readCodexAuth({ file, env = process.env } = {}) {
  return readJson(
    file ?? path.join(env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json"),
    "Codex auth",
  );
}

export function jwtExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function stageCodex(json, { minValidMs = 0, now = Date.now() } = {}) {
  if (json?.auth_mode !== "chatgpt") {
    throw new Error(
      "Codex login is not a ChatGPT login (auth_mode must be chatgpt); run `codex login` on the host",
    );
  }
  const tokens = json.tokens;
  if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw new Error("Codex login has no access token; run `codex login` on the host");
  }
  const exp = jwtExpMs(tokens.access_token);
  if (exp === undefined)
    throw new Error(
      "Codex access token has no readable expiry; run `codex` on the host to refresh the login, then retry",
    );
  const left = exp - now;
  if (!(left >= minValidMs)) {
    throw new Error(
      `Codex access token expires in ${Math.max(0, Math.round(left / 60000))} min, less than the ${Math.ceil(minValidMs / 60000)} min needed; run \`codex\` on the host to refresh the login, then retry`,
    );
  }
  const { OPENAI_API_KEY: _k, ...rest } = json;
  return { ...rest, tokens: { ...tokens, refresh_token: "" } };
}

export function secretValues(staged) {
  const out = [];
  const add = (v) => {
    if (typeof v === "string" && v.length >= MIN_SECRET_LEN) out.push(v);
  };
  add(staged?.claudeAiOauth?.accessToken);
  add(staged?.tokens?.access_token);
  add(staged?.tokens?.id_token);
  return out;
}

export function redact(text, secrets) {
  let count = 0;
  let out = text;
  for (const s of secrets) {
    if (typeof s !== "string" || s.length < MIN_SECRET_LEN) continue;
    const parts = out.split(s);
    count += parts.length - 1;
    out = parts.join("[REDACTED]");
  }
  return { text: out, count };
}
