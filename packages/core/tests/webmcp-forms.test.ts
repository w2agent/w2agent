import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { ExtractedForm, GenerateContext } from "../src/generate/types.js";
import { generateWebMcp } from "../src/generate/webmcp.js";

// Behaviour of execute (what the page's form receives) is checked in a real browser in
// the slice evidence; these tests pin what gets registered. The fake only records calls.

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  annotations: Record<string, boolean>;
  execute: unknown;
}

const BASE = "https://example.com";

function ctxWith(...pages: { path: string; forms: ExtractedForm[] }[]): GenerateContext {
  return {
    pages: pages.map((p) => ({
      url: `${BASE}${p.path}`,
      title: "t",
      description: "",
      markdown: "",
      forms: p.forms,
    })),
    rawPages: [],
    metadata: { baseUrl: BASE, wellKnown: {} },
    baseUrl: BASE,
  };
}

function emit(ctx: GenerateContext) {
  const files = generateWebMcp(ctx);
  return {
    js: files.find((f) => f.filename === "webmcp/webmcp.js")?.content ?? "",
    html: files.find((f) => f.filename === "webmcp/declarative.html")?.content ?? "",
  };
}

function registered(js: string): Tool[] {
  const tools: Tool[] = [];
  const sandbox = { document: { modelContext: { registerTool: (t: Tool) => tools.push(t) } } };
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox);
  return tools;
}

const search: ExtractedForm = {
  action: "/find",
  method: "get",
  fields: [{ name: "query", type: "search", required: false }],
};

const contact: ExtractedForm = {
  action: "/contact-submit",
  method: "post",
  fields: [
    { name: "name", type: "text", required: true },
    { name: "subscribe", type: "checkbox", required: false, value: "yes" },
    { name: "plan", type: "radio", required: false, options: ["basic", "pro"] },
    { name: "topics", type: "checkbox", required: false, options: ["a", "b"] },
    { name: "size", type: "select", required: false, options: ["s", "m"] },
    { name: "attachment", type: "file", required: false },
    { name: "message", type: "textarea", required: false },
  ],
};

const login: ExtractedForm = {
  action: "/login-submit",
  method: "post",
  fields: [
    { name: "user", type: "text", required: true },
    { name: "pass", type: "password", required: true },
  ],
};

describe("webmcp forms (GEN-6)", () => {
  it("registers no tool for password forms or forms with a required file", () => {
    const withFile: ExtractedForm = {
      action: "/upload",
      method: "post",
      fields: [
        { name: "title", type: "text", required: false },
        { name: "doc", type: "file", required: true },
      ],
    };
    const { js, html } = emit(ctxWith({ path: "/", forms: [login, withFile] }));
    expect(js).toBe("");
    expect(html).toBe("");
  });

  it("one tool for a search form repeated on every page", () => {
    const pages = ["/", "/a", "/b", "/c", "/d", "/e", "/f"].map((path) => ({
      path,
      forms: [search],
    }));
    const { js, html } = emit(ctxWith(...pages));
    const tools = registered(js);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("find");
    expect(html.match(/<form /g)).toHaveLength(1);
  });

  it("a differing form to the same action is a second tool", () => {
    const other: ExtractedForm = {
      ...search,
      fields: [{ name: "term", type: "text", required: false }],
    };
    const tools = registered(emit(ctxWith({ path: "/", forms: [search, other] })).js);
    expect(tools.map((t) => t.name)).toEqual(["find", "find-2"]);
  });

  it("maps radio, checkbox, group and select; omits the optional file and the password", () => {
    const { js, html } = emit(ctxWith({ path: "/contact", forms: [contact, login] }));
    const tools = registered(js);
    expect(tools).toHaveLength(1);
    const p = tools[0].inputSchema.properties;
    expect(Object.keys(p)).toEqual(["name", "subscribe", "plan", "topics", "size", "message"]);
    expect(p.subscribe.type).toBe("boolean");
    expect(p.plan).toMatchObject({ type: "string", enum: ["basic", "pro"] });
    expect(p.topics).toMatchObject({ type: "array", items: { type: "string", enum: ["a", "b"] } });
    expect(p.size).toMatchObject({ type: "string", enum: ["s", "m"] });
    expect(tools[0].inputSchema.required).toEqual(["name"]);
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("password");
    expect(html).toContain('type="radio" value="pro"');
    expect(html).toContain('<option value="m">m</option>');
  });

  it("annotations: GET is readOnly; non-GET is consequential; no destructiveHint", () => {
    const tools = registered(emit(ctxWith({ path: "/", forms: [search, contact] })).js);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true });
    expect(tools[1].annotations).toEqual({ readOnlyHint: false, consequentialHint: true });
  });

  it("declarative html: toolautosubmit only for GET, method normalised", () => {
    const { html } = emit(ctxWith({ path: "/", forms: [search, contact] }));
    const formLines = html.split("\n").filter((l) => l.startsWith("<form "));
    expect(formLines[0]).toContain('method="GET"');
    expect(formLines[0]).toContain("toolautosubmit");
    expect(formLines[1]).toContain('method="POST"');
    expect(formLines[1]).not.toContain("toolautosubmit");
  });

  it("dialog forms register nothing", () => {
    const dialog: ExtractedForm = { ...contact, method: "dialog" };
    expect(emit(ctxWith({ path: "/", forms: [dialog] })).js).toBe("");
  });

  it("the runtime is free of HTML, template and arrow syntax and never reads shadowable properties", () => {
    const { js } = emit(ctxWith({ path: "/", forms: [search] }));
    for (const bad of ["<", ">", "&", "{{", "{%"]) expect(js.includes(bad)).toBe(false);
    expect(js).toContain("HTMLFormElement.prototype.requestSubmit");
    expect(js).toContain("HTMLFormElement.prototype.checkValidity.call(form)");
    expect(js).not.toMatch(/\bform\.(action|method|submit|elements)\b/);
  });
});
