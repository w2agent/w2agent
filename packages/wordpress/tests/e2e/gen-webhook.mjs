// usage: node gen-webhook.mjs <core dist index.js> <out file>
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [distIndex, out] = process.argv.slice(2);
const core = await import(pathToFileURL(distIndex).href);
const files = core.wordpressAdapter.generateIntegration(
  { pages: [], rawPages: [], metadata: { baseUrl: "http://localhost", wellKnown: {} }, baseUrl: "http://localhost" },
  [
    { filename: "llms.txt", content: "# x\n", size: 4 },
    { filename: "robots.txt", content: "User-agent: *\nAllow: /\n", size: 23 },
    { filename: "mcp-server/server.js", content: "//", size: 2 },
  ],
);
const hook = files.find((f) => f.filename === "wordpress/w2agent-mcp-webhook.php");
if (!hook) throw new Error("no webhook file");
writeFileSync(out, hook.content);
console.log(`wrote ${out}`);
