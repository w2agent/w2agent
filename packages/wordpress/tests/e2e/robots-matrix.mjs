// Usage: node robots-matrix.mjs <cases.json> <matrix-output.json>
// <matrix-output.json> comes from robots-matrix.php run inside WordPress against both plugin copies.
// Each case is judged by robots-parser. Prints "ok <label>" or "FAIL <label>" per assertion.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const coreManifest = fileURLToPath(new URL("../../../core/package.json", import.meta.url));
const robotsParser = createRequire(coreManifest)("robots-parser");
const { BOT_TOKENS } = await import(
  new URL("../../../core/dist/audit/shared/bot-tokens.js", import.meta.url)
);

const [casesFile, matrixFile] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(casesFile, "utf-8"));
const matrix = JSON.parse(readFileSync(matrixFile, "utf-8"));
const tokens = BOT_TOKENS.filter(
  (b) => b.robotsToken && (b.purpose === "user" || b.purpose === "search"),
).map((b) => b.token);
const base = "http://example.test";
const parse = (text) => robotsParser(`${base}/robots.txt`, text);
const allowed = (r, agent, path = "/") => r.isAllowed(`${base}${path}`, agent) !== false;

const out = (ok, label) => console.log(`${ok ? "ok  " : "FAIL"} ${label}`);

for (const c of cases) {
  const row = matrix.find((m) => m.name === c.name);
  if (!row) {
    out(false, `${c.name}: missing from the WordPress run`);
    continue;
  }
  const original = parse(c.robots);
  out(
    allowed(original, "zz-unlisted-agent") === !c.blocksRoot,
    `${c.name}: table agrees with robots-parser (blocksRoot=${c.blocksRoot})`,
  );
  out(
    row.generated === row.standalone,
    `${c.name}: generated and standalone copies add the same text`,
  );
  const named = new Set((c.named ?? []).map((n) => n.toLowerCase()));
  for (const copy of ["generated", "standalone"]) {
    const added = row[copy];
    const combined = parse(`${c.robots}\n${added}`);
    const unnamedTokens = tokens.filter((t) => !named.has(t.toLowerCase()));
    out(
      (added !== "") === (c.blocksRoot && unnamedTokens.length > 0 && !c.open),
      `${c.name} [${copy}]: adds a group only when * blocks the root and no agent group is left open`,
    );
    out(
      !added.split("\n").some((l) => /^user-agent:\s*\*/i.test(l) || /^sitemap:/i.test(l)),
      `${c.name} [${copy}]: no User-agent: * and no Sitemap in the addition`,
    );
    for (const t of tokens) {
      const want = named.has(t.toLowerCase())
        ? allowed(original, t)
        : c.blocksRoot && !c.open
          ? true
          : allowed(original, t);
      out(allowed(combined, t) === want, `${c.name} [${copy}]: ${t} at / (${want ? "allowed" : "blocked"})`);
    }
    for (const t of ["GPTBot", "ClaudeBot", "CCBot", "zz-unlisted-agent"]) {
      out(
        allowed(combined, t) === allowed(original, t),
        `${c.name} [${copy}]: ${t} is unchanged`,
      );
    }
    for (const line of c.addedContains ?? []) {
      out(added.split(/\r?\n/).includes(line), `${c.name} [${copy}]: addition contains "${line}"`);
    }
    for (const p of c.paths ?? []) {
      out(
        allowed(combined, p.agent, p.path) === p.allowed,
        `${c.name} [${copy}]: ${p.agent} ${p.path} ${p.allowed ? "allowed" : "blocked"}`,
      );
    }
  }
}
