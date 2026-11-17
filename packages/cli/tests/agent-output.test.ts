import { describe, expect, it, vi } from "vitest";
import {
  AGENT_ENV_VARS,
  apiKeyValues,
  argvHasJson,
  buildErrorEnvelope,
  EXIT,
  enterJsonMode,
  insertFlags,
  isReason,
  loginRequiresApiKey,
  REASONS,
  redactArgv,
  redactMessage,
  sanitizeNext,
} from "../src/agent/output.js";
import { parseNonNegativeInt, parsePositiveInt, withLargerTimeout } from "../src/commands/audit.js";

describe("error envelope", () => {
  it("has the documented shape", () => {
    const env = buildErrorEnvelope(
      {
        reason: "timeout",
        message: "slow",
        next: [["w2agent", "audit", "a.com", "--timeout", "2"]],
      },
      ["w2agent", "audit", "a.com"],
    );
    expect(env).toEqual({
      ok: false,
      error: {
        reason: "timeout",
        message: "slow",
        userActionRequired: false,
        retryable: true,
        next: [["w2agent", "audit", "a.com", "--timeout", "2"]],
      },
    });
  });

  it("defaults next to an empty list", () => {
    const env = buildErrorEnvelope({ reason: "blocked", message: "m" }, ["w2agent", "audit", "x"]);
    expect(env.error.next).toEqual([]);
    expect(env.error.userActionRequired).toBe(true);
    expect(env.error.retryable).toBe(false);
  });
});

describe("reason table", () => {
  it("covers every contract reason", () => {
    for (const r of [
      "unreachable",
      "blocked",
      "auth_gated",
      "rate_limited",
      "timeout",
      "unknown_failure",
      "invalid_url",
      "invalid_argument",
      "no_platform_detected",
      "not_a_project",
      "auth_required",
      "below_threshold",
    ]) {
      expect(isReason(r)).toBe(true);
    }
    expect(isReason("toString")).toBe(false);
    expect(isReason("nope")).toBe(false);
  });

  it("uses exit 2 only for usage reasons", () => {
    const usage = Object.entries(REASONS)
      .filter(([, v]) => v.exitCode === EXIT.usage)
      .map(([k]) => k)
      .sort();
    expect(usage).toEqual(["invalid_argument", "invalid_url"]);
    expect(REASONS.auth_required).toMatchObject({
      userActionRequired: true,
      retryable: false,
      exitCode: EXIT.operational,
    });
  });
});

describe("next rules", () => {
  const failing = ["w2agent", "audit", "https://a.com"];

  it("drops an entry equal to the failing argv", () => {
    expect(sanitizeNext([failing, ["w2agent", "schema"]], failing)).toEqual([
      ["w2agent", "schema"],
    ]);
  });

  it("redacts --token in both forms, in argv and in messages", () => {
    expect(redactArgv(["w2agent", "agent", "--token=w2wh_secret", "update"])).toEqual([
      "w2agent",
      "agent",
      "--token=<api-key>",
      "update",
    ]);
    expect(redactArgv(["w2agent", "agent", "--token", "w2wh_secret", "update"])).toEqual([
      "w2agent",
      "agent",
      "--token",
      "<api-key>",
      "update",
    ]);
    expect(redactMessage("unknown option '--token=w2wh_secret'")).not.toContain("secret");
    expect(apiKeyValues(["w2agent", "--token", "w2wh_secret"])).toEqual(["w2wh_secret"]);
  });

  it("redacts --api-key in both forms", () => {
    expect(redactArgv(["w2agent", "login", "--api-key", "w2a_secret"])).toEqual([
      "w2agent",
      "login",
      "--api-key",
      "<api-key>",
    ]);
    expect(redactArgv(["w2agent", "login", "--api-key=w2a_secret"])).toEqual([
      "w2agent",
      "login",
      "--api-key=<api-key>",
    ]);
    const out = JSON.stringify(
      sanitizeNext(
        [
          ["w2agent", "login", "--api-key", "w2a_secret"],
          ["w2agent", "login", "--api-key=w2a_secret"],
        ],
        failing,
      ),
    );
    expect(out).not.toContain("w2a_secret");
  });

  it("drops an entry that equals the failing argv apart from the secret", () => {
    const failingLogin = ["w2agent", "login", "--api-key", "bad"];
    expect(sanitizeNext([["w2agent", "login", "--api-key", "<api-key>"]], failingLogin)).toEqual(
      [],
    );
  });

  it("never leaks a secret through the envelope", () => {
    const env = buildErrorEnvelope(
      { reason: "invalid_argument", message: "m", next: [["w2agent", "login", "--api-key=w2a_x"]] },
      ["w2agent", "audit", "u"],
    );
    expect(JSON.stringify(env)).not.toContain("w2a_x");
  });

  it("raises the timeout, replacing either form or appending", () => {
    expect(withLargerTimeout(["w2agent", "audit", "u", "--timeout", "2000"], 2000)).toEqual([
      "w2agent",
      "audit",
      "u",
      "--timeout",
      "4000",
    ]);
    expect(withLargerTimeout(["w2agent", "audit", "u", "--timeout=2000"], 2000)).toEqual([
      "w2agent",
      "audit",
      "u",
      "--timeout=4000",
    ]);
    expect(withLargerTimeout(["w2agent", "audit", "u"], 10000)).toEqual([
      "w2agent",
      "audit",
      "u",
      "--timeout",
      "20000",
    ]);
  });
});

describe("terminator placement", () => {
  it("inserts flags before -- and appends without one", () => {
    expect(insertFlags(["w2agent", "integrate", "--", "u"], ["--platform", "nextjs"])).toEqual([
      "w2agent",
      "integrate",
      "--platform",
      "nextjs",
      "--",
      "u",
    ]);
    expect(insertFlags(["w2agent", "integrate", "u"], ["--platform", "nextjs"])).toEqual([
      "w2agent",
      "integrate",
      "u",
      "--platform",
      "nextjs",
    ]);
  });

  it("puts a doubled --timeout before --, and leaves an option after -- alone", () => {
    expect(withLargerTimeout(["w2agent", "audit", "--json", "--", "u"], 2000)).toEqual([
      "w2agent",
      "audit",
      "--json",
      "--timeout",
      "4000",
      "--",
      "u",
    ]);
    expect(withLargerTimeout(["w2agent", "audit", "--", "--timeout", "7"], 2000)).toEqual([
      "w2agent",
      "audit",
      "--timeout",
      "4000",
      "--",
      "--timeout",
      "7",
    ]);
  });
});

describe("message redaction", () => {
  it("redacts the literal --api-key value wherever it appears, including values with spaces", () => {
    const env = buildErrorEnvelope(
      {
        reason: "unknown_failure",
        message: "bad key my secret key here and again my secret key here",
      },
      ["w2agent", "login", "--api-key", "my secret key here"],
    );
    expect(env.error.message).toBe("bad key <api-key> and again <api-key>");
    const eq = buildErrorEnvelope(
      { reason: "unknown_failure", message: "got s3cret-value-1 twice: s3cret-value-1" },
      ["w2agent", "login", "--api-key=s3cret-value-1"],
    );
    expect(eq.error.message).toBe("got <api-key> twice: <api-key>");
  });

  it("redacts w2a_ tokens and --api-key values in the envelope message", () => {
    const env = buildErrorEnvelope(
      {
        reason: "invalid_argument",
        message: "unknown option '--apikey=w2a_SECRET'; got --api-key hunter2 and --api-key=abc",
      },
      ["w2agent"],
    );
    expect(env.error.message).not.toMatch(/SECRET|hunter2|abc/);
    expect(env.error.message).toContain("--api-key <api-key>");
    expect(env.error.message).toContain("--api-key=<api-key>");
  });

  it("leaves the bare w2a_ prefix hint alone", () => {
    expect(redactMessage("Keys must start with w2a_")).toBe("Keys must start with w2a_");
  });
});

describe("argument helpers", () => {
  it("accepts zero for non-negative integers only", () => {
    expect(parseNonNegativeInt("0")).toBe(0);
    expect(parseNonNegativeInt("70")).toBe(70);
    expect(parseNonNegativeInt("-1")).toBeUndefined();
    expect(parseNonNegativeInt("x")).toBeUndefined();
  });

  it("parses strictly positive integers only", () => {
    expect(parsePositiveInt("5")).toBe(5);
    for (const bad of ["0", "-1", "1.5", "abc", "10x", "", undefined]) {
      expect(parsePositiveInt(bad)).toBeUndefined();
    }
  });

  it("detects --json before a bare --", () => {
    expect(argvHasJson(["audit", "u", "--json"])).toBe(true);
    expect(argvHasJson(["audit", "u"])).toBe(false);
    expect(argvHasJson(["audit", "--", "--json"])).toBe(false);
  });
});

describe("loginRequiresApiKey", () => {
  it("requires an API key without a TTY", () => {
    expect(loginRequiresApiKey({}, false)).toBe(true);
    expect(loginRequiresApiKey({}, undefined)).toBe(true);
  });

  it("allows browser login on a TTY with no agent env", () => {
    expect(loginRequiresApiKey({}, true)).toBe(false);
    expect(loginRequiresApiKey({ AI_AGENT: "" }, true)).toBe(false);
  });

  it.each(AGENT_ENV_VARS)("requires an API key when %s is set", (name) => {
    expect(loginRequiresApiKey({ [name]: "1" }, true)).toBe(true);
  });
});

describe("enterJsonMode", () => {
  it("routes log, info, warn and debug to stderr until restored", () => {
    const orig = {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };
    const target = { ...orig } as unknown as Console;
    const mode = enterJsonMode(target);
    target.log("a");
    target.info("b");
    target.warn("c");
    target.debug("d");
    expect(orig.error.mock.calls).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(orig.log).not.toHaveBeenCalled();
    expect(orig.info).not.toHaveBeenCalled();
    mode.restore();
    target.log("e");
    expect(orig.log).toHaveBeenCalledWith("e");
  });
});
