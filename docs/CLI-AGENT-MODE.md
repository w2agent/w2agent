# CLI Agent Mode

Contract reference for scripts and AI agents that run `w2agent`. Add `--json` to `audit`, `integrate` and `login` to get one machine-readable document on stdout and a stable exit code.

## When to use `--json`

Use `--json` whenever a program, not a person, reads the output. Under `--json`:

- Stdout holds exactly one JSON document, written once at the end. Nothing else goes to stdout.
- Progress text, warnings and any other incidental output go to stderr.
- There is no spinner and there are no colours.
- Errors are a JSON envelope on stdout (see below). Without `--json`, errors are plain text on stderr.

`--json` is detected from the raw arguments, so even a mistyped command gets an envelope instead of usage text.

One exception: `--help` and `--version` print plain text even with `--json`, and exit 0.

## Exit codes

These codes apply to `audit`, `integrate`, `login` and `schema`, with or without `--json`.

| Code | Meaning |
|------|---------|
| `0` | Success (`--help` and `--version` also exit 0) |
| `1` | Operational error: the site, the project or the login state blocked the command |
| `2` | Usage error: invalid URL, unknown option, bad option value or missing argument |

`audit --ci` exits `1` when the score is below `--threshold`.

## Success documents

### `audit <url> --json`

The document is the same report as `-f json`. It has no `ok` field. Tell success by exit code 0.

```bash
w2agent audit http://127.0.0.1:<port> --json
```

```json
{
  "url": "http://127.0.0.1:<port>",
  "pagesScanned": 3,
  "overallScore": 27,
  "grade": "F",
  "rubricVersion": "3.2",
  "categories": [ "…" ]
}
```

With `--ci --json` and a score under the threshold, the output is the `below_threshold` error envelope instead of the report.

### `integrate <url> --json`

Every success document has `ok: true`, an `outcome` and the `platform`. `warnings` and `next` are always present.

| `outcome` | When | Extra fields |
|-----------|------|--------------|
| `planned` | `--dry-run` (with or without `--install`). Nothing is written. | `changes`, `postInstallSteps` |
| `installed` | `--install` | `changes`, `postInstallSteps` |
| `generated` | Default mode, files written to `--output` | `outputDir`, `files` |

Each entry in `changes` is `{ "action", "path", "reason" }`. `path` is relative to `--project-dir`. `action` is one of `create`, `skip` or `manual`. `integrate` never deletes or overwrites a file: a path that already exists is a `skip`. `skip` and `manual` entries need no write; read `reason` for what to do by hand.

```bash
w2agent integrate http://127.0.0.1:<port> --dry-run --json \
  --site-url https://acme.example --project-dir ./my-app
```

```json
{
  "ok": true,
  "outcome": "planned",
  "platform": "nextjs",
  "changes": [
    { "action": "create", "path": "middleware.ts", "reason": "new file" },
    { "action": "create", "path": "app/llms.txt/route.ts", "reason": "new file" },
    { "action": "create", "path": ".w2agent/llms.txt", "reason": "new file" }
  ],
  "warnings": [],
  "postInstallSteps": [
    "Add `\"prebuild\": \"node w2agent-build.mjs\"` to your package.json scripts. Needs the w2agent CLI installed in this project."
  ],
  "next": [
    ["w2agent", "integrate", "http://127.0.0.1:<port>", "--install", "--json",
     "--site-url", "https://acme.example", "--project-dir", "./my-app"]
  ]
}
```

(Shortened. A real run lists every change. A project with no `tsconfig.json` gets `.js` files (`middleware.js`) instead of `.ts`.) After `--install`, `next` is `audit <crawl url> --json`, carrying your `--timeout` and `--allow-host` when you gave them. It audits the crawled URL, not `--site-url`. Run it after the `postInstallSteps` and after you rebuild or restart the local server that serves the changes.

If `--platform` is forced and the crawl found no readable pages, `integrate` still plans or writes the scaffolding. It adds a `warnings` entry that says no pages were readable and why. Without `--platform` the same crawl is an error (below).

### `login --json`

```json
{ "ok": true, "outcome": "authenticated" }
```

`outcome` is `authenticated` after a login and `already_authenticated` when credentials already exist (pass `--force` to log in again).

With `--api-key`, the CLI checks the key against the server (`GET /api/cli/whoami`, 15 s timeout) before it saves anything. If the server answers 401 or 403, nothing is saved, an existing config file stays unchanged, and the result is `auth_required` with exit 1. If the check cannot finish (network error, timeout, any other status), the key is saved, a warning goes to stderr, and the result is still `authenticated` with exit 0. Stdout stays one JSON document.

## Error envelope

On failure, with `--json`, stdout holds:

```json
{
  "ok": false,
  "error": {
    "reason": "unreachable",
    "message": "Could not reach 127.0.0.1:<port>. Check the URL or your network connection.",
    "userActionRequired": false,
    "retryable": true,
    "next": []
  }
}
```

- `reason` is a stable code from the table below. Branch on it, not on `message`.
- `userActionRequired` is `true` when a person must act (for example allow-list a bot or supply a key). Do not retry blindly.
- `retryable` is `true` when the same command may succeed later.
- `next` is a list of argv arrays, each starting with `"w2agent"`. They are suggested follow-up commands. It is often empty.
- An `integrate --install` failure after the plan ran also carries `changes` (what was executed, as in the success document) and `postInstallSteps` (the steps that do not name a failed file). Both are optional. Files listed as `create` were written even though the command failed. Existing files are skipped on a re-run, so do those steps now.

### Reasons

| `reason` | Exit | `userActionRequired` | `retryable` | What to do |
|----------|------|----------------------|-------------|------------|
| `unreachable` | 1 | no | yes | The host did not answer. Check the URL, start the site, retry. |
| `blocked` | 1 | yes | no | The site refuses the crawler (bot protection, firewall). Ask the owner to allow it. |
| `auth_gated` | 1 | yes | no | The site needs a login. Audit a public URL instead. |
| `rate_limited` | 1 | no | yes | Wait, then retry. |
| `timeout` | 1 | no | yes | Retry with a larger `--timeout`. `audit` puts that command in `next`. |
| `unknown_failure` | 1 | no | no | Read `message`. Includes a page that returned nothing readable. |
| `invalid_url` | 2 | no | no | Fix the URL (also raised for a bad `--site-url`). |
| `invalid_argument` | 2 | no | no | Fix the option. Run `w2agent schema` for valid flags and values. |
| `no_platform_detected` | 1 | yes | no | `integrate` could not detect the platform. Ask which one, then pick an entry in `next` (one per platform, with `--platform`). Human mode with `--install` or `--dry-run` also exits 1 and writes nothing. Without them it writes the core files to `--output` and exits 0. |
| `not_a_project` | 1 | yes | no | `--project-dir` is missing, is not a project root for this platform, or the platform refused it (for example a Pages Router app). `--install` and `--dry-run` write nothing. Pass the right `--project-dir`. |
| `auth_required` | 1 | yes | no | Login needs an API key (see [login in agent environments](#login-in-agent-environments)), or the server rejected the key you passed to `login --api-key`. Create a new key and retry. |
| `below_threshold` | 1 | no | no | `audit --ci --json` scored under `--threshold`. This is a result, not a crash: fix the site, then audit again. |

`--install --json` also uses `unknown_failure` (exit 1) when a write failed or when nothing was installed because every path already existed. Human mode exits 1 in the same cases. With a partial failure the message names what was installed and what failed, and `error.changes` and `error.postInstallSteps` hold the executed changes and the steps still to do.

### `next` rules

- `next` never contains the command that just failed.
- `next` never contains a secret. The value of `--api-key` (both `--api-key v` and `--api-key=v`) becomes the placeholder `<api-key>`. Replace it with a real key before you run the command. The same value is also redacted wherever it appears in `message`.
- When the command line has a `--` terminator, added flags go before it.

## Plan, apply, verify

`integrate` can change a project, so show the plan to the user before you apply it.

1. Plan: `w2agent integrate <url> --dry-run --json --project-dir <dir>`. This never writes files.
2. Show the user `changes`, `warnings` and `postInstallSteps`.
3. Apply: run the argv in `next[0]`. It is the same command with `--install` and without `--dry-run`.
4. Verify: after the `postInstallSteps` and a rebuild or restart of the local server, run the argv in the `installed` document's `next` (`audit <crawl url> --json`).

## `--site-url`: crawl one origin, write for another

Use `--site-url <origin>` to crawl a local or preview server while the generated files name the production site:

```bash
w2agent integrate http://127.0.0.1:<port> --install --json \
  --site-url https://acme.example --project-dir ./my-app
```

`--site-url` must be an absolute `http` or `https` URL without credentials. Only its origin is used (a path, query or fragment is dropped). It rewrites:

- the crawl origin, in plain, JSON-escaped and percent-encoded form;
- `host:port` forms of the crawl host;
- loopback aliases (`localhost`, `127.0.0.1`, `[::1]`) on the same port.

The bare crawl hostname is rewritten only where it is a whole value that core derives from it (the site name): a line that is just the host or `# <host>`, and a quoted value that follows `:` or `=` and is exactly the host (`"name": "<host>"`, `name: "<host>"`). A quoted host in prose, such as `Use "localhost" for DB`, is left as written. A mention in prose, such as "open localhost in your browser", is left as written.

Every other mention of the crawl host is reported in `warnings` (on stderr in human mode). A warning means generated content still names the crawl host. Check it by hand before you publish.

## `w2agent schema`

`w2agent schema` prints every command, argument and option as JSON (names, flags, defaults, whether a value is taken, whether it is required). Read it instead of parsing `--help`. It exits 0, or 2 on a usage error.

## Secret values in output

The values of `--api-key` and `--token` (`--flag value` and `--flag=value`) are redacted to `<api-key>` as follows. Values shorter than 5 characters are not redacted by the text scrubber.

- Text written to stderr, and to stdout in human mode, is scrubbed for those exact values, ignoring case. Help and version text is never rewritten.
- Under `--json`, stdout is not text-scrubbed. The emitted document has the values replaced (ignoring case) in its string values only, never in keys, booleans or numbers.
- A secret flag given where another option expects a value (for example `--output --token=abc`, or `--format '--api-key=abc,def'`) is refused before the command runs: `invalid_argument`, exit 2, a fixed message naming the option, and no directory, file or request. The value is never echoed. Without a `=` (`--output --api-key abc`) the arguments are usually rejected as `too many arguments`, also exit 2.

## Hosted API address (`W2AGENT_API_URL`)

`login`, `whoami`, `deploy`, `agentize`, `agent status` and `agent update` talk to `https://w2agent.dev` unless `W2AGENT_API_URL` is set. The value must parse as a URL and use `https`, or use `http` with a loopback host (`localhost`, any `127.x.x.x` address, or `[::1]`). Any other scheme or host is refused before a credential is read or a request is sent: the result is `invalid_argument` (exit 2), and nothing is saved. The message names the variable and, when the value parses, its scheme and host. It never repeats the full value. A trailing slash is ignored; a path prefix is kept.

## Login in agent environments

Browser login needs a person at a terminal. `w2agent login` fails at once, with exit 1 and reason `auth_required`, when any of these is true:

- `AI_AGENT`, `CLAUDECODE` or `CODEX_CI` is set to a non-empty value;
- stdin is not a TTY.

Create an API key at [w2agent.dev](https://w2agent.dev), then run:

```bash
w2agent login --api-key <key> --json
```

A key that does not start with `w2a_`, an empty one (`--api-key=`), or one with a character outside visible ASCII (a space, a newline, a trailing `\r`), is rejected with `invalid_argument` (exit 2) before any request, and the key is not echoed. If the key or the browser token cannot be saved (for example an unwritable config directory), the result is `unknown_failure` with exit 1.
