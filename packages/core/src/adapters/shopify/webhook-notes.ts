export const SHOPIFY_WEBHOOK_TOPICS = [
  "products/create",
  "products/update",
  "products/delete",
  "collections/create",
  "collections/update",
  "collections/delete",
] as const;

const TOPIC_TOML = SHOPIFY_WEBHOOK_TOPICS.map((t) => `"${t}"`).join(", ");
const TOPIC_JS = SHOPIFY_WEBHOOK_TOPICS.map((t) => `  "${t}",`).join("\n");

const RELAY_SAMPLE = `const http = require("node:http");
const crypto = require("node:crypto");

const SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const TARGET = process.env.W2AGENT_WEBHOOK_URL;
const TOKEN = process.env.W2AGENT_WEBHOOK_TOKEN;
const PORT = Number(process.env.PORT) || 3000;
const PATH = "/webhooks/shopify";
const MAX_BODY = 1024 * 1024;
const TOPICS = new Set([
${TOPIC_JS}
]);

function allowedTarget(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

const missing = ["SHOPIFY_CLIENT_SECRET", "W2AGENT_WEBHOOK_URL", "W2AGENT_WEBHOOK_TOKEN"].filter(
  (name) => !process.env[name],
);
if (missing.length > 0) {
  console.error("Missing environment variables: " + missing.join(", "));
  process.exit(1);
}
if (!allowedTarget(TARGET)) {
  console.error("W2AGENT_WEBHOOK_URL must be an https URL");
  process.exit(1);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        chunks.length = 0;
        reject(new Error("too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => !failed && resolve(Buffer.concat(chunks)));
    req.on("aborted", () => !failed && ((failed = true), reject(new Error("aborted"))));
    req.on("error", (err) => !failed && ((failed = true), reject(err)));
  });
}

function validSignature(header, body) {
  if (typeof header !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(header)) return false;
  const given = Buffer.from(header, "base64");
  if (given.length !== 32) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest();
  return crypto.timingSafeEqual(given, expected);
}

async function forward(topic) {
  const res = await fetch(TARGET, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ trigger: "shopify", topic }),
    redirect: "manual",
    signal: AbortSignal.timeout(4000),
  });
  return res.ok;
}

const server = http.createServer(async (req, res) => {
  const reply = (status, text) => {
    res.writeHead(status, { "Content-Type": "text/plain", Connection: "close" });
    res.end(text);
  };
  try {
    if (new URL(req.url, "http://relay").pathname !== PATH) return reply(404, "Not found");
    if (req.method !== "POST") return reply(405, "Method not allowed");

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err.message === "too large") reply(413, "Payload too large");
      return;
    }

    if (!validSignature(req.headers["x-shopify-hmac-sha256"], body)) {
      return reply(401, "Invalid signature");
    }
    const topic = req.headers["x-shopify-topic"];
    if (!TOPICS.has(topic)) return reply(200, "Ignored");

    const ok = await forward(topic).catch(() => false);
    return ok ? reply(200, "OK") : reply(503, "Forward failed");
  } catch {
    if (!res.headersSent) reply(500, "Error");
  }
});

server.requestTimeout = 10000;
server.listen(PORT, () => console.log("Relay listening on port " + PORT));
`;

export function buildShopifyWebhookNotes(): string {
  return `# Shopify MCP Webhook Integration

Keep your hosted MCP server current when products or collections change.

## What does not work

Do not subscribe Shopify webhooks straight to \`https://w2agent.dev/api/agent/webhook/YOUR_SLUG\`. That endpoint expects an \`Authorization: Bearer <token>\` header. Shopify cannot add a custom header to a delivery. It signs each delivery with \`X-Shopify-Hmac-SHA256\` instead: the base64 HMAC-SHA256 of the raw body, keyed with your app's client secret.

The supported path is a small relay that you run. It checks the Shopify signature, then calls the w2agent endpoint with the Bearer token.

## 1. Get the webhook URL and token

\`\`\`bash
w2agent deploy https://your-store.example --show-token
\`\`\`

This prints the webhook URL (\`https://w2agent.dev/api/agent/webhook/YOUR_SLUG\`) and the webhook token. Without \`--show-token\` the token is masked.

## 2. Run the relay

Save this as \`w2agent-relay.cjs\` and host it anywhere that runs Node 18 or newer, and make it reachable over HTTPS (for example behind a TLS-terminating proxy or host). It has no dependencies.

\`\`\`js
${RELAY_SAMPLE}\`\`\`

Set these environment variables:
- \`SHOPIFY_CLIENT_SECRET\`: the client secret of the Shopify app that owns the subscriptions
- \`W2AGENT_WEBHOOK_URL\`: the webhook URL from step 1 (https, or a loopback host for local tests)
- \`W2AGENT_WEBHOOK_TOKEN\`: the webhook token from step 1

The relay answers 200 only after w2agent accepted the call. Otherwise it answers 503 and Shopify retries. A duplicate delivery only triggers one more update, which is safe. If you already have a Shopify app built on the React Router template, \`authenticate.webhook(request)\` does the signature check for you ([docs](https://shopify.dev/docs/apps/build/webhooks/subscribe/https)); forward to w2agent from that handler instead.

## 3. Subscribe in shopify.app.toml

Create a Shopify app with Shopify CLI, install it on your store, and add this to \`shopify.app.toml\`. Replace the \`uri\` with the public HTTPS address of your relay.

\`\`\`toml
[webhooks]
api_version = "2026-10"

[[webhooks.subscriptions]]
topics = [${TOPIC_TOML}]
uri = "https://your-relay.example.com/webhooks/shopify"
\`\`\`

Then run \`shopify app deploy\`. See [subscribe to webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started).

## 4. Test

\`\`\`bash
shopify app webhook trigger --topic products/update --api-version 2026-10 --address https://your-relay.example.com/webhooks/shopify --client-secret <SHOPIFY_CLIENT_SECRET>
\`\`\`

Passing \`--client-secret\` makes the command sign the request with the HMAC header. See [webhook trigger](https://shopify.dev/docs/api/shopify-cli/app/app-webhook-trigger).

## Online Store content

Online Store pages and blog posts have no webhook topic. After you edit them, run \`w2agent agent update YOUR_SLUG\` to re-crawl the hosted deployment.
`;
}
