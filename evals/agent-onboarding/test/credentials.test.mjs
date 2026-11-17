import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  readClaudeLogin,
  readCodexAuth,
  redact,
  secretValues,
  stageClaude,
  stageCodex,
} from "../credentials.mjs";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const ACCESS = "sk-ant-oat-ACCESSTOKEN-0123456789";
const REFRESH = "sk-ant-ort-REFRESHTOKEN-0123456789";

const claudeLogin = (expiresAt) => ({
  claudeAiOauth: {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt,
    refreshTokenExpiresAt: expiresAt + 1000,
    scopes: ["user:inference"],
    subscriptionType: "max",
  },
  mcpOAuth: { server: { accessToken: "mcp-secret-0123456789" } },
});

const jwt = (expSec) =>
  `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url")}.sig`;

const codexAuth = (expSec, extra = {}) => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: "sk-openai-key-0123456789",
  tokens: {
    access_token: jwt(expSec),
    id_token: jwt(expSec + 1),
    refresh_token: "rt-0123456789abcdef",
    account_id: "acct",
  },
  last_refresh: "2026-01-01T00:00:00Z",
  ...extra,
});

test("stageClaude strips refresh fields and other top-level keys", () => {
  const staged = stageClaude(claudeLogin(NOW + 8 * HOUR), { minValidMs: HOUR, now: NOW });
  assert.deepEqual(Object.keys(staged), ["claudeAiOauth"]);
  assert.equal(staged.claudeAiOauth.accessToken, ACCESS);
  assert.equal(staged.claudeAiOauth.refreshToken, undefined);
  assert.equal(staged.claudeAiOauth.refreshTokenExpiresAt, undefined);
  assert.deepEqual(staged.claudeAiOauth.scopes, ["user:inference"]);
  assert.ok(!JSON.stringify(staged).includes(REFRESH));
});

test("stageClaude rejects near-expiry and missing tokens without leaking secrets", () => {
  assert.throws(
    () => stageClaude(claudeLogin(NOW + HOUR / 2), { minValidMs: HOUR, now: NOW }),
    (e) => {
      assert.match(e.message, /run `claude` on the host/);
      assert.ok(!e.message.includes(ACCESS));
      return true;
    },
  );
  assert.throws(() => stageClaude(claudeLogin(NOW - 1), { minValidMs: 0, now: NOW }), /expires/);
  for (const bad of [undefined, "soon", Number.NaN]) {
    const l = claudeLogin(0);
    l.claudeAiOauth.expiresAt = bad;
    assert.throws(() => stageClaude(l, { now: NOW }), /no valid expiresAt/);
  }
  assert.throws(() => stageClaude({ claudeAiOauth: {} }, { now: NOW }), /no access token/);
  assert.throws(() => stageClaude({}, { now: NOW }), /no access token/);
});

test("stageCodex blanks refresh_token and drops OPENAI_API_KEY", () => {
  const input = codexAuth(NOW / 1000 + 10 * 24 * 3600);
  const staged = stageCodex(input, { minValidMs: HOUR, now: NOW });
  assert.equal(staged.tokens.refresh_token, "");
  assert.ok("refresh_token" in staged.tokens);
  assert.equal(staged.OPENAI_API_KEY, undefined);
  assert.equal(staged.auth_mode, "chatgpt");
  assert.equal(staged.tokens.access_token, input.tokens.access_token);
  assert.equal(staged.tokens.account_id, "acct");
  assert.equal(input.tokens.refresh_token, "rt-0123456789abcdef");
});

test("stageCodex rejects non-chatgpt, missing token, and near-expiry", () => {
  const soon = NOW / 1000 + 600;
  assert.throws(
    () => stageCodex(codexAuth(soon + 1e6, { auth_mode: "apikey" }), { now: NOW }),
    /ChatGPT login/,
  );
  assert.throws(
    () => stageCodex({ auth_mode: "chatgpt", tokens: {} }, { now: NOW }),
    /no access token/,
  );
  assert.throws(
    () => stageCodex(codexAuth(soon), { minValidMs: HOUR, now: NOW }),
    /run `codex` on the host/,
  );
  const bad = codexAuth(soon);
  bad.tokens.access_token = "not-a-jwt";
  assert.throws(() => stageCodex(bad, { now: NOW }), /no readable expiry/);
});

test("secretValues lists access and id tokens only", () => {
  const claude = stageClaude(claudeLogin(NOW + 8 * HOUR), { now: NOW });
  assert.deepEqual(secretValues(claude), [ACCESS]);
  const codex = stageCodex(codexAuth(NOW / 1000 + 86400), { now: NOW });
  assert.deepEqual(secretValues(codex), [codex.tokens.access_token, codex.tokens.id_token]);
});

test("redact replaces every occurrence, counts, and skips short values", () => {
  const { text, count } = redact(`a ${ACCESS} b ${ACCESS} c`, [ACCESS, "short", ""]);
  assert.equal(text, "a [REDACTED] b [REDACTED] c");
  assert.equal(count, 2);
  const keep = redact("the word short appears", ["short"]);
  assert.equal(keep.text, "the word short appears");
  assert.equal(keep.count, 0);
});

test("readClaudeLogin: explicit file wins and never calls the keychain", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "creds-"));
  const f = path.join(dir, "c.json");
  writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
  const keychain = () => assert.fail("keychain must not be read");
  assert.deepEqual(readClaudeLogin({ file: f, env: {}, platform: "darwin", keychain }), {
    claudeAiOauth: { accessToken: "x" },
  });
});

test("readClaudeLogin: darwin default dir uses the keychain", () => {
  const login = readClaudeLogin({
    env: {},
    platform: "darwin",
    keychain: () => ({ from: "keychain" }),
  });
  assert.deepEqual(login, { from: "keychain" });
});

test("readClaudeLogin: CLAUDE_CONFIG_DIR reads the file, never the keychain", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "creds-"));
  writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ from: "file" }));
  const keychain = () => assert.fail("keychain must not be read");
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(readClaudeLogin({ env: { CLAUDE_CONFIG_DIR: dir }, platform, keychain }), {
      from: "file",
    });
  }
});

test("readClaudeLogin: darwin custom dir without a file explains the flag", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "creds-"));
  assert.throws(
    () => readClaudeLogin({ env: { CLAUDE_CONFIG_DIR: dir }, platform: "darwin" }),
    /--claude-credentials/,
  );
});

test("readCodexAuth prefers CODEX_HOME and an explicit file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-"));
  mkdirSync(path.join(dir, "h"));
  writeFileSync(path.join(dir, "h", "auth.json"), JSON.stringify({ from: "home" }));
  writeFileSync(path.join(dir, "x.json"), JSON.stringify({ from: "file" }));
  assert.deepEqual(readCodexAuth({ env: { CODEX_HOME: path.join(dir, "h") } }), { from: "home" });
  assert.deepEqual(
    readCodexAuth({ file: path.join(dir, "x.json"), env: { CODEX_HOME: "/nonexistent" } }),
    { from: "file" },
  );
});
