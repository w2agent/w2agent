// Usage: node robots-query.mjs <robots.txt file> <agent> <path> [<agent> <path> ...]
// Prints "allowed" or "blocked" per pair, using the same robots-parser the core audit uses.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const coreManifest = fileURLToPath(new URL("../../../core/package.json", import.meta.url));
const robotsParser = createRequire(coreManifest)("robots-parser");

const [file, ...pairs] = process.argv.slice(2);
const base = "http://example.test";
const robots = robotsParser(`${base}/robots.txt`, readFileSync(file, "utf-8"));
for (let i = 0; i < pairs.length; i += 2) {
  console.log(robots.isAllowed(`${base}${pairs[i + 1]}`, pairs[i]) === false ? "blocked" : "allowed");
}
