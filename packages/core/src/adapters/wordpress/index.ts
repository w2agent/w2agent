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
    const llmsFullTxt = coreFiles.find((f) => f.filename === "llms-full.txt")?.content;
    const files = generateWpPlugin(llmsTxt, agentCard, ctx.baseUrl, llmsFullTxt);

    // Add MCP webhook snippet if mcp-server format is active
    if (coreFiles.some((f) => f.filename.startsWith("mcp-server/"))) {
      const webhookSnippet = `<?php
/**
 * w2agent MCP Webhook — WordPress Integration
 *
 * Triggers a re-crawl of your MCP server when published content changes.
 * Replace YOUR_SLUG and YOUR_WEBHOOK_TOKEN below. Until you do, nothing is sent.
 * The w2agent plugin in this folder (w2agent-plugin.php) loads this file for you.
 * You can also paste it into your theme's functions.php instead. A copy that still holds the
 * placeholders does nothing, so a configured copy works wherever it is loaded.
 */
if (!defined('ABSPATH')) exit;

$w2agent_mcp_url = 'https://w2agent.dev/api/agent/webhook/YOUR_SLUG';
$w2agent_mcp_token = 'YOUR_WEBHOOK_TOKEN';

// A copy that still holds the placeholders defines nothing and adds no hooks, so a configured copy
// elsewhere (for example in functions.php) works whatever the load order. The placeholder words are
// split so a find-and-replace of the two values above cannot rewrite this check.
if (
    strpos($w2agent_mcp_url, 'YOUR' . '_SLUG') === false
    && $w2agent_mcp_token !== 'YOUR' . '_WEBHOOK_TOKEN'
    && !defined('W2AGENT_MCP_WEBHOOK_HOOKED')
) {
    define('W2AGENT_MCP_WEBHOOK_HOOKED', true);
    if (!defined('W2AGENT_WEBHOOK_URL')) define('W2AGENT_WEBHOOK_URL', $w2agent_mcp_url);
    if (!defined('W2AGENT_WEBHOOK_TOKEN')) define('W2AGENT_WEBHOOK_TOKEN', $w2agent_mcp_token);

    // Only types that llms.txt lists: the generated plugin's type list when it is loaded,
    // otherwise any publicly viewable type (menu items, revisions and the like never are).
    $w2agent_mcp_notify = function ($post) {
        $post = get_post($post);
        if (!$post || wp_is_post_revision($post) || wp_is_post_autosave($post)) return;
        if (function_exists('w2agent_site_post_types')) {
            if (!in_array($post->post_type, w2agent_site_post_types(), true)) return;
        } elseif (!is_post_type_viewable($post->post_type)) {
            return;
        }

        wp_remote_post(W2AGENT_WEBHOOK_URL, array(
            'headers' => array(
                'Content-Type'  => 'application/json',
                'Authorization' => 'Bearer ' . W2AGENT_WEBHOOK_TOKEN,
            ),
            'body'    => wp_json_encode(array(
                'trigger' => 'wordpress',
                'post_id' => $post->ID,
            )),
            'blocking' => false,
        ));
    };

    // Publish, update of a published post, unpublish and trash all have "publish" as the old or new status.
    add_action('transition_post_status', function ($new_status, $old_status, $post) use ($w2agent_mcp_notify) {
        if ($new_status !== 'publish' && $old_status !== 'publish') return;
        $w2agent_mcp_notify($post);
    }, 10, 3);

    // Permanent deletion of a post that is still published (trashed posts were announced when trashed).
    add_action('before_delete_post', function ($post_id, $post = null) use ($w2agent_mcp_notify) {
        $post = $post ? $post : get_post($post_id);
        if (!$post || $post->post_status !== 'publish') return;
        $w2agent_mcp_notify($post);
    }, 10, 2);
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
 * Loaded by w2agent-plugin.php from this folder; nothing else to set up.
 */
if (!defined('ABSPATH')) exit;

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
