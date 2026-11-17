import chalk from "chalk";

export const EXIT = { ok: 0, operational: 1, usage: 2 } as const;

export type Reason =
  | "unreachable"
  | "blocked"
  | "auth_gated"
  | "rate_limited"
  | "timeout"
  | "unknown_failure"
  | "invalid_url"
  | "invalid_argument"
  | "no_platform_detected"
  | "not_a_project"
  | "auth_required"
  | "below_threshold";

interface ReasonInfo {
  userActionRequired: boolean;
  retryable: boolean;
  exitCode: number;
}

export const REASONS: Record<Reason, ReasonInfo> = {
  unreachable: { userActionRequired: false, retryable: true, exitCode: EXIT.operational },
  blocked: { userActionRequired: true, retryable: false, exitCode: EXIT.operational },
  auth_gated: { userActionRequired: true, retryable: false, exitCode: EXIT.operational },
  rate_limited: { userActionRequired: false, retryable: true, exitCode: EXIT.operational },
  timeout: { userActionRequired: false, retryable: true, exitCode: EXIT.operational },
  unknown_failure: { userActionRequired: false, retryable: false, exitCode: EXIT.operational },
  invalid_url: { userActionRequired: false, retryable: false, exitCode: EXIT.usage },
  invalid_argument: { userActionRequired: false, retryable: false, exitCode: EXIT.usage },
  no_platform_detected: { userActionRequired: true, retryable: false, exitCode: EXIT.operational },
  not_a_project: { userActionRequired: true, retryable: false, exitCode: EXIT.operational },
  auth_required: { userActionRequired: true, retryable: false, exitCode: EXIT.operational },
  below_threshold: { userActionRequired: false, retryable: false, exitCode: EXIT.operational },
};

export const AGENT_ENV_VARS = ["AI_AGENT", "CLAUDECODE", "CODEX_CI"] as const;

export const API_KEY_PLACEHOLDER = "<api-key>";

export function isReason(value: string): value is Reason {
  return Object.hasOwn(REASONS, value);
}

/** An AuditError's kind maps to the same-named reason; anything else is unknown_failure. */
export function reasonOfError(err: unknown): Reason {
  const e = err as { kind?: unknown; name?: unknown } | null;
  const isAuditError = typeof e === "object" && e !== null && e.name === "AuditError";
  return isAuditError && typeof e.kind === "string" && isReason(e.kind)
    ? e.kind
    : "unknown_failure";
}

export function currentArgv(): string[] {
  return ["w2agent", ...process.argv.slice(2)];
}

export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--api-key" && i + 1 < argv.length) {
      out.push(arg, API_KEY_PLACEHOLDER);
      i++;
    } else if (arg.startsWith("--api-key=")) {
      out.push(`--api-key=${API_KEY_PLACEHOLDER}`);
    } else {
      out.push(arg);
    }
  }
  return out;
}

export function apiKeyValues(argv: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--api-key" && i + 1 < argv.length) values.push(argv[i + 1]);
    else if (arg.startsWith("--api-key=")) values.push(arg.slice("--api-key=".length));
  }
  // Shorter values would also match ordinary words in a message.
  return values.filter((v) => v.length >= 5).sort((a, b) => b.length - a.length);
}

export function redactMessage(message: string, secrets: readonly string[] = []): string {
  let text = message;
  for (const secret of secrets) text = text.split(secret).join(API_KEY_PLACEHOLDER);
  return text
    .replace(/--api-key([= ])\S+/g, `--api-key$1${API_KEY_PLACEHOLDER}`)
    .replace(/w2a_[A-Za-z0-9_-]+/g, API_KEY_PLACEHOLDER);
}

/** Adds flags to an argv, ahead of a `--` terminator when there is one. */
export function insertFlags(argv: readonly string[], flags: readonly string[]): string[] {
  const end = argv.indexOf("--");
  return end === -1 ? [...argv, ...flags] : [...argv.slice(0, end), ...flags, ...argv.slice(end)];
}

export function sanitizeNext(
  next: readonly (readonly string[])[],
  failingArgv: readonly string[],
): string[][] {
  const failing = JSON.stringify(redactArgv(failingArgv));
  return next
    .map((entry) => redactArgv(entry))
    .filter((entry) => JSON.stringify(entry) !== failing);
}

export interface Failure {
  reason: Reason;
  message: string;
  next?: readonly (readonly string[])[];
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    reason: Reason;
    message: string;
    userActionRequired: boolean;
    retryable: boolean;
    next: string[][];
  };
}

export function buildErrorEnvelope(
  failure: Failure,
  failingArgv: readonly string[],
): ErrorEnvelope {
  const info = REASONS[failure.reason];
  return {
    ok: false,
    error: {
      reason: failure.reason,
      message: redactMessage(failure.message, apiKeyValues(failingArgv)),
      userActionRequired: info.userActionRequired,
      retryable: info.retryable,
      next: sanitizeNext(failure.next ?? [], failingArgv),
    },
  };
}

export function argvHasJson(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--json");
}

export function jsonRequested(): boolean {
  return argvHasJson(process.argv.slice(2));
}

export function loginRequiresApiKey(
  env: Record<string, string | undefined>,
  stdinIsTTY: boolean | undefined,
): boolean {
  if (!stdinIsTTY) return true;
  return AGENT_ENV_VARS.some((name) => (env[name] ?? "") !== "");
}

type ConsoleLike = Pick<Console, "log" | "info" | "warn" | "debug" | "error">;

export interface JsonMode {
  emit(doc: unknown): Promise<void>;
  restore(): void;
}

/**
 * Routes incidental console output to stderr and holds stdout for the one
 * final document. Colour is off so stderr text stays plain.
 */
export function enterJsonMode(target: ConsoleLike = console): JsonMode {
  const saved = {
    log: target.log,
    info: target.info,
    warn: target.warn,
    debug: target.debug,
  };
  const toStderr = (...args: unknown[]) => target.error(...args);
  target.log = toStderr;
  target.info = toStderr;
  target.warn = toStderr;
  target.debug = toStderr;
  const savedLevel = chalk.level;
  chalk.level = 0;
  return {
    emit(doc) {
      const text = typeof doc === "string" ? doc : JSON.stringify(doc, null, 2);
      return new Promise((resolve) => {
        process.stdout.write(`${text}\n`, () => resolve());
      });
    },
    restore() {
      Object.assign(target, saved);
      chalk.level = savedLevel;
    },
  };
}

/**
 * Reports a failure and sets the exit code; the caller returns afterwards so
 * stdout drains before the process ends. Under --json stdout carries only the
 * envelope; otherwise the message goes to stderr.
 */
export async function failWith(
  json: JsonMode | undefined,
  failure: Failure,
  failingArgv: readonly string[] = currentArgv(),
  human: string = failure.message,
): Promise<void> {
  process.exitCode = REASONS[failure.reason].exitCode;
  if (json) {
    await json.emit(buildErrorEnvelope(failure, failingArgv));
  } else {
    console.error(human);
  }
}
