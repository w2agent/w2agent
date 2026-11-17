interface AdminClient {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response>;
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
  return `${split.slice(0, words).join(" ")}...`;
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
  query Products($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active AND published_status:published") {
      edges {
        node {
          title
          handle
          onlineStoreUrl
          descriptionHtml
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const PAGES_QUERY = `#graphql
  query Pages($first: Int!, $after: String) {
    pages(first: $first, after: $after, query: "published_status:published") {
      edges {
        node {
          title
          handle
          isPublished
          body
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

function assertNoErrors(body: { errors?: unknown } | null | undefined) {
  if (!body?.errors) return;
  const errors = body.errors;
  const message = Array.isArray(errors)
    ? errors
        .map((e) => (e && typeof e.message === "string" ? e.message : "unknown error"))
        .join("; ")
    : String(errors);
  throw new Error(`Shopify Admin API returned errors: ${message}`);
}

const PAGE_SIZE = 250;
const MAX_ITEMS = 2000;

async function fetchAll<T>(admin: AdminClient, query: string, rootField: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;

  while (items.length < MAX_ITEMS) {
    const variables: Record<string, unknown> = { first: PAGE_SIZE };
    if (cursor) variables.after = cursor;

    const res = await admin.graphql(query, { variables });
    const data = await res.json();
    assertNoErrors(data);
    const connection = data?.data?.[rootField];
    if (!connection?.edges || !connection.pageInfo) {
      throw new Error(`Shopify Admin API response is missing data.${rootField}`);
    }
    for (const { node } of connection.edges) {
      items.push(node);
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return items;
}

interface Product {
  title: string;
  handle: string;
  onlineStoreUrl: string | null;
  descriptionHtml: string;
}

interface Page {
  title: string;
  handle: string;
  isPublished: boolean;
  body: string;
}

export async function generateLlmsTxt(admin: AdminClient): Promise<string> {
  const [shopRes, allProducts, allPages] = await Promise.all([
    admin.graphql(SHOP_QUERY),
    fetchAll<Product>(admin, PRODUCTS_QUERY, "products"),
    fetchAll<Page>(admin, PAGES_QUERY, "pages"),
  ]);

  const products = allProducts.filter((p) => p.onlineStoreUrl != null);
  const pages = allPages.filter((p) => p.isPublished === true);

  const shopData = await shopRes.json();
  assertNoErrors(shopData);
  const shop = shopData?.data?.shop;
  if (!shop?.primaryDomain?.url) {
    throw new Error("Shopify Admin API response is missing data.shop");
  }
  const baseUrl = shop.primaryDomain.url;

  let output = `# ${shop.name}\n\n`;
  if (shop.description) {
    output += `> ${shop.description}\n\n`;
  }

  if (products.length > 0) {
    output += "## Products\n\n";
    for (const node of products) {
      const desc = node.descriptionHtml ? truncate(stripHtml(node.descriptionHtml), 25) : "";
      const url = `${baseUrl}/products/${node.handle}`;
      output += desc ? `- [${node.title}](${url}): ${desc}\n` : `- [${node.title}](${url})\n`;
    }
    output += "\n";
  }

  if (pages.length > 0) {
    output += "## Pages\n\n";
    for (const node of pages) {
      const desc = node.body ? truncate(stripHtml(node.body), 25) : "";
      const url = `${baseUrl}/pages/${node.handle}`;
      output += desc ? `- [${node.title}](${url}): ${desc}\n` : `- [${node.title}](${url})\n`;
    }
    output += "\n";
  }

  return output;
}
