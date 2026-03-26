interface AdminClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response>;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, words: number): string {
  const split = text.split(/\s+/);
  if (split.length <= words) return text;
  return split.slice(0, words).join(" ") + "...";
}

const SHOP_QUERY = `#graphql
  query ShopInfo {
    shop {
      name
      description
      primaryDomain { url }
    }
  }
`;

const PRODUCTS_QUERY = `#graphql
  query Products($first: Int!) {
    products(first: $first, query: "status:active") {
      edges {
        node {
          title
          handle
          descriptionHtml
        }
      }
    }
  }
`;

const PAGES_QUERY = `#graphql
  query Pages($first: Int!) {
    pages(first: $first) {
      edges {
        node {
          title
          handle
          body
        }
      }
    }
  }
`;

export async function generateLlmsTxt(admin: AdminClient): Promise<string> {
  const [shopRes, productsRes, pagesRes] = await Promise.all([
    admin.graphql(SHOP_QUERY),
    admin.graphql(PRODUCTS_QUERY, { variables: { first: 100 } }),
    admin.graphql(PAGES_QUERY, { variables: { first: 100 } }),
  ]);

  const shopData = await shopRes.json();
  const productsData = await productsRes.json();
  const pagesData = await pagesRes.json();

  const shop = shopData.data.shop;
  const baseUrl = shop.primaryDomain.url;

  let output = `# ${shop.name}\n\n`;
  if (shop.description) {
    output += `> ${shop.description}\n\n`;
  }

  const products = productsData.data.products.edges;
  if (products.length > 0) {
    output += "## Products\n\n";
    for (const { node } of products) {
      const desc = node.descriptionHtml
        ? truncate(stripHtml(node.descriptionHtml), 25)
        : "";
      const url = `${baseUrl}/products/${node.handle}`;
      output += desc
        ? `- [${node.title}](${url}): ${desc}\n`
        : `- [${node.title}](${url})\n`;
    }
    output += "\n";
  }

  const pages = pagesData.data.pages.edges;
  if (pages.length > 0) {
    output += "## Pages\n\n";
    for (const { node } of pages) {
      const desc = node.body ? truncate(stripHtml(node.body), 25) : "";
      const url = `${baseUrl}/pages/${node.handle}`;
      output += desc
        ? `- [${node.title}](${url}): ${desc}\n`
        : `- [${node.title}](${url})\n`;
    }
    output += "\n";
  }

  return output;
}
