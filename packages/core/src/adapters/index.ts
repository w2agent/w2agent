import { astroAdapter } from "./astro/index.js";
import { docusaurusAdapter } from "./docusaurus/index.js";
import { nextjsAdapter } from "./nextjs/index.js";
import { nuxtAdapter } from "./nuxt/index.js";
import { registerAdapter } from "./registry.js";
import { shopifyAdapter } from "./shopify/index.js";
import { wordpressAdapter } from "./wordpress/index.js";

registerAdapter(wordpressAdapter);
registerAdapter(nextjsAdapter);
registerAdapter(shopifyAdapter);
registerAdapter(docusaurusAdapter);
registerAdapter(nuxtAdapter);
registerAdapter(astroAdapter);

export {
  wordpressAdapter,
  nextjsAdapter,
  shopifyAdapter,
  docusaurusAdapter,
  nuxtAdapter,
  astroAdapter,
};
