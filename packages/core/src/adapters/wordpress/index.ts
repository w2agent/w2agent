import type { FetchedPage, SiteMetadata } from "../../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { wordpressChecks } from "./checks.js";
import { resolveWordPressInstall } from "./install.js";
import { generateWpPlugin } from "./templates.js";

export const wordpressAdapter: PlatformAdapter = {
  id: "wordpress",
  name: "WordPress",
  description: "WordPress CMS — serves llms.txt via plugin, hooks into robots_txt filter",

  detect(pages: FetchedPage[], _metadata: SiteMetadata): PlatformDetectionResult | null {
    let confidence = 0;
    let version: string | undefined;
    const details: Record<string, string> = {};

    for (const page of pages) {
      // Generator meta tag (highest confidence)
      const genMatch = page.html.match(
        /<meta\s+name=["']generator["']\s+content=["']WordPress\s*([\d.]*)/i,
      );
      if (genMatch) {
        confidence = Math.max(confidence, 1.0);
        version = genMatch[1] || undefined;
        details.signal = "generator meta tag";
      }

      // wp-content / wp-includes paths
      if (page.html.includes("/wp-content/") || page.html.includes("/wp-includes/")) {
        confidence = Math.max(confidence, 0.95);
        details.assets = "wp-content/wp-includes detected";
      }

      // wp-json link header
      if (page.headers.link?.includes("wp-json") || page.html.includes("wp-json")) {
        confidence = Math.max(confidence, 0.85);
        details.api = "wp-json link detected";
      }
    }

    if (confidence === 0) return null;

    return { platform: "wordpress", confidence, version, details };
  },

  checks: wordpressChecks,

  resolveInstall: resolveWordPressInstall,

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[] {
    const llmsTxt = coreFiles.find((f) => f.filename === "llms.txt")?.content || "";
    const agentCard = coreFiles.find((f) => f.filename === "agent-card.json")?.content;
    const robotsTxt = coreFiles.find((f) => f.filename === "robots.txt")?.content || "";

    // Extract just the AI-specific rules from generated robots.txt
    const robotsRules = robotsTxt
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("Sitemap:"))
      .join("\n");

    const files = generateWpPlugin(llmsTxt, agentCard, robotsRules, ctx.baseUrl);

    // Add MCP webhook snippet if mcp-server format is active
    if (coreFiles.some((f) => f.filename.startsWith("mcp-server/"))) {
      const webhookSnippet = `<?php
/**
 * w2agent MCP Webhook — WordPress Integration
 *
 * Add this to your theme's functions.php or a custom plugin.
 * Triggers a re-crawl of your MCP server when content changes.
 */

define('W2AGENT_WEBHOOK_URL', 'https://w2agent.dev/api/agent/webhook/YOUR_SLUG');
define('W2AGENT_WEBHOOK_TOKEN', 'YOUR_WEBHOOK_TOKEN');

add_action('save_post', 'w2agent_mcp_notify', 10, 3);
add_action('delete_post', 'w2agent_mcp_notify', 10, 1);

function w2agent_mcp_notify($post_id, $post = null, $update = true) {
    // Only trigger on published posts/pages
    if ($post && $post->post_status !== 'publish') return;

    wp_remote_post(W2AGENT_WEBHOOK_URL, array(
        'headers' => array(
            'Content-Type'  => 'application/json',
            'Authorization' => 'Bearer ' . W2AGENT_WEBHOOK_TOKEN,
        ),
        'body'    => wp_json_encode(array(
            'trigger' => 'wordpress',
            'post_id' => $post_id,
        )),
        'blocking' => false,
    ));
}
`;
      files.push({
        filename: "wordpress/w2agent-mcp-webhook.php",
        content: webhookSnippet,
        size: new TextEncoder().encode(webhookSnippet).length,
      });
    }

    if (coreFiles.some((f) => f.filename.startsWith("webmcp/"))) {
      const webmcpJs = coreFiles.find((f) => f.filename === "webmcp/webmcp.js")?.content || "";
      if (webmcpJs) {
        const webmcpPhp = `<?php
/**
 * W2Agent WebMCP Registration
 * Outputs WebMCP tool registration script in the footer.
 * Add to your theme's functions.php: require_once __DIR__ . '/w2agent-webmcp.php';
 */
add_action('wp_footer', function() {
?>
<script>
${webmcpJs}
</script>
<?php
}, 99);
`;
        files.push({
          filename: "wordpress/w2agent-webmcp.php",
          content: webmcpPhp,
          size: new TextEncoder().encode(webmcpPhp).length,
        });
      }
    }

    return files;
  },
};
