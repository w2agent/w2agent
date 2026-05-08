import { describe, expect, it } from "vitest";
import type { GenerateContext } from "../src/generate/types.js";
import { generateWebMcp } from "../src/generate/webmcp.js";

function makeCtx(overrides: Partial<GenerateContext> = {}): GenerateContext {
  return {
    pages: overrides.pages ?? [],
    rawPages: overrides.rawPages ?? [],
    metadata: overrides.metadata ?? { baseUrl: "https://example.com", wellKnown: {} },
    baseUrl: overrides.baseUrl ?? "https://example.com",
  };
}

describe("generateWebMcp", () => {
  it("returns empty array when no forms exist", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/",
          title: "Home",
          description: "",
          markdown: "Hello",
          forms: undefined,
        },
      ],
    });
    expect(generateWebMcp(ctx)).toEqual([]);
  });

  it("returns empty array when forms have only hidden fields", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/",
          title: "Home",
          description: "",
          markdown: "Hello",
          forms: [
            {
              action: "/submit",
              method: "POST",
              fields: [{ name: "_csrf", type: "hidden", required: false }],
            },
          ],
        },
      ],
    });
    expect(generateWebMcp(ctx)).toEqual([]);
  });

  it("produces declarative.html and webmcp.js for a single form", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/contact",
          title: "Contact",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/contact",
              method: "POST",
              fields: [
                { name: "email", type: "email", required: true },
                { name: "message", type: "text", required: false },
              ],
            },
          ],
        },
      ],
    });
    const files = generateWebMcp(ctx);
    const filenames = files.map((f) => f.filename);
    expect(filenames).toContain("webmcp/declarative.html");
    expect(filenames).toContain("webmcp/webmcp.js");
  });

  it("declarative HTML includes toolname and tooldescription", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/contact",
          title: "Contact",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/contact",
              method: "POST",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
      ],
    });
    const files = generateWebMcp(ctx);
    const html = files.find((f) => f.filename === "webmcp/declarative.html")!;
    expect(html.content).toContain('toolname="contact"');
    expect(html.content).toContain('tooldescription="Submit the contact form"');
  });

  it("declarative HTML adds toolautosubmit only for GET forms", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/search",
          title: "Search",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/search",
              method: "GET",
              fields: [{ name: "q", type: "text", required: false }],
            },
          ],
        },
        {
          url: "https://example.com/contact",
          title: "Contact",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/contact",
              method: "POST",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
      ],
    });
    const files = generateWebMcp(ctx);
    const html = files.find((f) => f.filename === "webmcp/declarative.html")!;

    // Extract form tag lines to check toolautosubmit presence per form
    const lines = html.content.split("\n");
    const searchFormLine = lines.find((l) => l.includes('action="/search"'));
    const contactFormLine = lines.find((l) => l.includes('action="/contact"'));

    expect(searchFormLine).toContain("toolautosubmit");
    expect(contactFormLine).not.toContain("toolautosubmit");
  });

  it("declarative HTML skips hidden fields", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/contact",
          title: "Contact",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/contact",
              method: "POST",
              fields: [
                { name: "_csrf", type: "hidden", required: false },
                { name: "email", type: "email", required: true },
              ],
            },
          ],
        },
      ],
    });
    const files = generateWebMcp(ctx);
    const html = files.find((f) => f.filename === "webmcp/declarative.html")!;
    expect(html.content).not.toContain("_csrf");
    expect(html.content).toContain("email");
  });

  it("imperative JS includes feature detection", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/contact",
          title: "Contact",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/contact",
              method: "POST",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
      ],
    });
    const files = generateWebMcp(ctx);
    const js = files.find((f) => f.filename === "webmcp/webmcp.js")!;
    expect(js.content).toContain('"modelContext" in navigator');
  });

  it("imperative JS includes registerTool for each form", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/search",
          title: "Search",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/search",
              method: "GET",
              fields: [{ name: "q", type: "text", required: false }],
            },
          ],
        },
        {
          url: "https://example.com/contact",
          title: "Contact",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/contact",
              method: "POST",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
      ],
    });
    const files = generateWebMcp(ctx);
    const js = files.find((f) => f.filename === "webmcp/webmcp.js")!;
    expect((js.content.match(/registerTool/g) || []).length).toBe(2);
  });

  it("imperative JS includes correct annotations", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/search",
          title: "Search",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/search",
              method: "GET",
              fields: [{ name: "q", type: "text", required: false }],
            },
          ],
        },
        {
          url: "https://example.com/contact",
          title: "Contact",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/contact",
              method: "POST",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
      ],
    });
    const files = generateWebMcp(ctx);
    const js = files.find((f) => f.filename === "webmcp/webmcp.js")!;
    expect(js.content).toContain("readOnlyHint: true");
    expect(js.content).toContain("readOnlyHint: false");
    expect(js.content).toContain("destructiveHint: true");
    expect(js.content).toContain("destructiveHint: false");
  });

  it("imperative JS generates correct inputSchema types", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/form",
          title: "Form",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/form",
              method: "POST",
              fields: [
                { name: "email", type: "email", required: false },
                { name: "qty", type: "number", required: false, min: "1", max: "100" },
                {
                  name: "color",
                  type: "select",
                  required: false,
                  options: ["red", "blue", "green"],
                },
                { name: "agree", type: "checkbox", required: false },
              ],
            },
          ],
        },
      ],
    });
    const files = generateWebMcp(ctx);
    const js = files.find((f) => f.filename === "webmcp/webmcp.js")!;
    expect(js.content).toContain('"format": "email"');
    expect(js.content).toContain('"type": "number"');
    expect(js.content).toContain('"type": "boolean"');
    expect(js.content).toContain('"enum"');
  });
});

describe("tool name inference", () => {
  it("infers name from action URL path", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/",
          title: "Home",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/api/search",
              method: "GET",
              fields: [{ name: "q", type: "text", required: false }],
            },
          ],
        },
      ],
    });
    const files = generateWebMcp(ctx);
    const html = files.find((f) => f.filename === "webmcp/declarative.html")!;
    expect(html.content).toContain('toolname="search"');
  });

  it("deduplicates tool names with numeric suffix", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/page1",
          title: "Page 1",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/search",
              method: "GET",
              fields: [{ name: "q", type: "text", required: false }],
            },
          ],
        },
        {
          url: "https://example.com/page2",
          title: "Page 2",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/search",
              method: "GET",
              fields: [{ name: "q", type: "text", required: false }],
            },
          ],
        },
      ],
    });
    const files = generateWebMcp(ctx);
    const js = files.find((f) => f.filename === "webmcp/webmcp.js")!;
    expect(js.content).toContain('"search"');
    expect(js.content).toContain('"search-2"');
  });

  it("uses fallback name for forms without useful action", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/",
          title: "Home",
          description: "",
          markdown: "",
          forms: [
            {
              action: "#",
              method: "POST",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
      ],
    });
    const files = generateWebMcp(ctx);
    const html = files.find((f) => f.filename === "webmcp/declarative.html")!;
    expect(html.content).toContain('toolname="form-0"');
  });
});

describe("field-to-schema mapping", () => {
  function makeFormCtx(
    fields: Array<{
      name: string;
      type: string;
      required: boolean;
      min?: string;
      max?: string;
      options?: string[];
    }>,
  ) {
    return makeCtx({
      pages: [
        {
          url: "https://example.com/form",
          title: "Form",
          description: "",
          markdown: "",
          forms: [{ action: "/form", method: "POST", fields }],
        },
      ],
    });
  }

  it("maps email to string with format", () => {
    const ctx = makeFormCtx([{ name: "email", type: "email", required: false }]);
    const js = generateWebMcp(ctx).find((f) => f.filename === "webmcp/webmcp.js")!;
    expect(js.content).toContain('"format": "email"');
  });

  it("maps url to string with uri format", () => {
    const ctx = makeFormCtx([{ name: "website", type: "url", required: false }]);
    const js = generateWebMcp(ctx).find((f) => f.filename === "webmcp/webmcp.js")!;
    expect(js.content).toContain('"format": "uri"');
  });

  it("maps number with min/max", () => {
    const ctx = makeFormCtx([
      { name: "qty", type: "number", required: false, min: "1", max: "100" },
    ]);
    const js = generateWebMcp(ctx).find((f) => f.filename === "webmcp/webmcp.js")!;
    expect(js.content).toContain('"minimum": 1');
    expect(js.content).toContain('"maximum": 100');
  });

  it("maps select with enum values", () => {
    const ctx = makeFormCtx([
      { name: "color", type: "select", required: false, options: ["red", "blue", "green"] },
    ]);
    const js = generateWebMcp(ctx).find((f) => f.filename === "webmcp/webmcp.js");
    if (!js) throw new Error("webmcp.js not generated");
    expect(js.content).toContain('"enum"');
  });
});

// Security: hostile field names / form.action must never land in generated JS
// as bare identifiers, or in declarative HTML as unescaped attribute values.
describe("generateWebMcp — injection defenses (security)", () => {
  const HOSTILE_NAME = '"]); evil(); ([x';
  const HOSTILE_ACTION = '"><script>evil()</script>';

  const ctxWithHostileName = () =>
    ({
      pages: [
        {
          url: "https://example.com/form",
          title: "Form",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/form",
              method: "POST",
              fields: [{ name: HOSTILE_NAME, type: "text", required: false }],
            },
          ],
        },
      ],
      rawPages: [],
      metadata: { baseUrl: "https://example.com", wellKnown: {} },
      baseUrl: "https://example.com",
    }) satisfies GenerateContext;

  const ctxWithHostileAction = () =>
    ({
      pages: [
        {
          url: "https://example.com/form",
          title: "Form",
          description: "",
          markdown: "",
          forms: [
            {
              action: HOSTILE_ACTION,
              method: "POST",
              fields: [{ name: "email", type: "text", required: false }],
            },
          ],
        },
      ],
      rawPages: [],
      metadata: { baseUrl: "https://example.com", wellKnown: {} },
      baseUrl: "https://example.com",
    }) satisfies GenerateContext;

  it("webmcp.js never emits hostile field name as bare JS identifier", () => {
    const js = generateWebMcp(ctxWithHostileName()).find((f) => f.filename === "webmcp/webmcp.js");
    if (!js) throw new Error("webmcp.js not generated");
    // Bare-identifier patterns that would let an attacker break out
    expect(js.content).not.toContain(`const ${HOSTILE_NAME}Field`);
    expect(js.content).not.toContain(`params.${HOSTILE_NAME}`);
    // Safe access must use bracket notation with the quoted name
    expect(js.content).toContain(`params[${JSON.stringify(HOSTILE_NAME)}]`);
  });

  it("declarative.html escapes hostile form action in attribute position", () => {
    const html = generateWebMcp(ctxWithHostileAction()).find(
      (f) => f.filename === "webmcp/declarative.html",
    );
    if (!html) throw new Error("declarative.html not generated");
    // Attacker content must not close the attribute or open a script tag
    expect(html.content).not.toContain(HOSTILE_ACTION);
    // Escaped form should preserve the data but neutralize it
    expect(html.content).toContain("&quot;");
    expect(html.content).toContain("&lt;script&gt;");
  });

  it("declarative.html escapes hostile field name in attribute position", () => {
    const html = generateWebMcp(ctxWithHostileName()).find(
      (f) => f.filename === "webmcp/declarative.html",
    );
    if (!html) throw new Error("declarative.html not generated");
    expect(html.content).not.toContain(`name="${HOSTILE_NAME}"`);
    expect(html.content).toContain("&quot;");
  });
});
