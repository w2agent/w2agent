import { registerAdapter } from "./registry.js";
import { wordpressAdapter } from "./wordpress/index.js";
import { nextjsAdapter } from "./nextjs/index.js";
import { shopifyAdapter } from "./shopify/index.js";
import { docusaurusAdapter } from "./docusaurus/index.js";

registerAdapter(wordpressAdapter);
registerAdapter(nextjsAdapter);
registerAdapter(shopifyAdapter);
registerAdapter(docusaurusAdapter);

export { wordpressAdapter, nextjsAdapter, shopifyAdapter, docusaurusAdapter };
