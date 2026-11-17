import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { ExtractedForm, GenerateContext } from "../src/generate/types.js";
import { generateWebMcp } from "../src/generate/webmcp.js";

// A small fake DOM that provides exactly what the emitted runtime touches. It is not a
// browser: the Chromium evidence in the handoff covers real form semantics. What it does
// give is a regression net for the execute logic (what is set, what is refused, how the
// form is submitted and found).

const BASE = "https://example.com";

interface Result {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface Tool {
  name: string;
  execute: (params: unknown) => Promise<Result>;
}

class Control {
  events: string[] = [];
  files: unknown[] | undefined;
  required = false;
  options: string[] | undefined;
  group: Control[] = [];
  private _value: string;
  private _on = false;
  willValidate = true;
  constructor(
    public type: string,
    public name: string,
    value = "",
    opts: { required?: boolean; options?: string[]; checked?: boolean; files?: unknown[] } = {},
  ) {
    this._value = value;
    this.required = opts.required ?? false;
    this.options = opts.options;
    this.files = type === "file" ? (opts.files ?? []) : undefined;
    this._on = opts.checked ?? false;
  }
  get value() {
    return this._value;
  }
  set value(v: string) {
    if (this.options && !this.options.includes(v)) this._value = "";
    else this._value = v;
  }
  get id() {
    return "";
  }
  get checked() {
    return this._on;
  }
  set checked(v: boolean) {
    this._on = v;
    if (v && this.type === "radio") {
      for (const o of this.group) if (o !== this) o._on = false;
    }
  }
  get validity() {
    return { valid: !(this.required && this.isEmpty()) };
  }
  private isEmpty() {
    return this.type === "checkbox" || this.type === "radio" ? !this._on : this._value === "";
  }
  dispatchEvent(e: { type: string }) {
    this.events.push(e.type);
    return true;
  }
}
interface Submission {
  how: "requestSubmit" | "submit";
  form: FakeForm;
  data: [string, string][];
}

class FakeForm {
  constructor(
    public _action: string,
    public _method: string,
    public _elements: Control[],
    shadow = false,
  ) {
    const radios = _elements.filter((c) => c.type === "radio");
    for (const r of radios) r.group = radios.filter((o) => o.name === r.name);
    if (shadow) {
      // Named-property shadowing: inputs named like form members hide them on the instance.
      for (const k of [
        "action",
        "method",
        "submit",
        "elements",
        "checkValidity",
        "requestSubmit",
      ]) {
        Object.defineProperty(this, k, { value: new Control("text", k, "evil"), enumerable: true });
      }
    }
  }
  data(): [string, string][] {
    const out: [string, string][] = [];
    for (const c of this._elements) {
      if (!c.name || c.type === "submit" || c.type === "file") continue;
      if ((c.type === "checkbox" || c.type === "radio") && !c.checked) continue;
      out.push([c.name, c.value]);
    }
    return out;
  }
}

function run(
  forms: FakeForm[],
  extraction: ExtractedForm[],
  opts: { noRequestSubmit?: boolean } = {},
) {
  const submissions: Submission[] = [];
  const tools: Tool[] = [];
  function HTMLFormElement() {}
  function Document() {}
  const proto = HTMLFormElement.prototype as Record<string, unknown>;
  const accessor = (key: string, get: (this: FakeForm) => unknown) =>
    Object.defineProperty(proto, key, { get, configurable: true });
  accessor("action", function () {
    return this._action;
  });
  accessor("method", function () {
    return this._method;
  });
  accessor("elements", function () {
    return this._elements;
  });
  proto.checkValidity = function (this: FakeForm) {
    return this._elements.every((c) => !c.willValidate || c.validity.valid);
  };
  if (!opts.noRequestSubmit) {
    proto.requestSubmit = function (this: FakeForm) {
      submissions.push({ how: "requestSubmit", form: this, data: this.data() });
    };
  }
  proto.submit = function (this: FakeForm) {
    submissions.push({ how: "submit", form: this, data: this.data() });
  };
  for (const f of forms) Object.setPrototypeOf(f, HTMLFormElement.prototype);
  // setPrototypeOf drops FakeForm methods; keep data() reachable
  for (const f of forms) {
    (f as unknown as { data: () => unknown }).data = FakeForm.prototype.data.bind(f);
  }
  Object.defineProperty(Document.prototype, "forms", { get: () => forms });
  const document = Object.create(Document.prototype);
  document.modelContext = { registerTool: (t: Tool) => tools.push(t) };
  const sandbox = {
    document,
    Document,
    HTMLFormElement,
    URL,
    location: { origin: BASE },
    Event: class {
      constructor(
        public type: string,
        public init?: unknown,
      ) {}
    },
  };
  vm.createContext(sandbox);
  const ctx: GenerateContext = {
    pages: [{ url: `${BASE}/p`, title: "t", description: "", markdown: "", forms: extraction }],
    rawPages: [],
    metadata: { baseUrl: BASE, wellKnown: {} },
    baseUrl: BASE,
  };
  const js = generateWebMcp(ctx).find((f) => f.filename === "webmcp/webmcp.js")?.content ?? "";
  vm.runInContext(js, sandbox);
  const tool = (name: string) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  return { tool, submissions, tools };
}

const contactForm: ExtractedForm = {
  action: "/contact-submit",
  method: "post",
  fields: [
    { name: "name", type: "text", required: true },
    { name: "email", type: "email", required: true },
    { name: "phone", type: "text", required: false },
    { name: "subscribe", type: "checkbox", required: false, value: "yes" },
    { name: "plan", type: "radio", required: false, options: ["basic", "pro"] },
    { name: "topics", type: "checkbox", required: false, options: ["a", "b"] },
    { name: "message", type: "textarea", required: false },
  ],
};

function liveContact(over: { checked?: string[]; extra?: Control[]; shadow?: boolean } = {}) {
  const c = (type: string, name: string, value = "", o = {}) => new Control(type, name, value, o);
  const checked = over.checked ?? [];
  const controls = [
    c("text", "name", "", { required: true }),
    c("email", "email", "", { required: true }),
    c("text", "phone"),
    c("checkbox", "subscribe", "yes", { checked: checked.includes("subscribe") }),
    c("radio", "plan", "basic"),
    c("radio", "plan", "pro"),
    c("checkbox", "topics", "a", { checked: checked.includes("a") }),
    c("checkbox", "topics", "b", { checked: checked.includes("b") }),
    c("textarea", "message"),
    c("submit", "submit", "go"),
    ...(over.extra ?? []),
  ];
  return new FakeForm("https://example.com/contact-submit", "post", controls, over.shadow);
}

const ok = { name: "Ann", email: "a@b.co" };
const names = (s: Submission) => s.data.map(([k]) => k);

describe("webmcp execute against a fake DOM", () => {
  it("submits with requestSubmit and sends no value for omitted optionals", async () => {
    const live = liveContact();
    const { tool, submissions } = run([live], [contactForm]);
    const r = await tool("contact-submit").execute({ ...ok, phone: null, message: undefined });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("requested");
    expect(submissions).toHaveLength(1);
    expect(submissions[0].how).toBe("requestSubmit");
    const values = submissions[0].data.map(([, v]) => v);
    expect(values).not.toContain("undefined");
    expect(values).not.toContain("null");
    expect(names(submissions[0])).toEqual(["name", "email", "phone", "message"]);
  });

  it("checkbox true sets its value; false unchecks; events fire on changed controls", async () => {
    const on = run([liveContact()], [contactForm]);
    await on.tool("contact-submit").execute({ ...ok, subscribe: true });
    expect(on.submissions[0].data).toContainEqual(["subscribe", "yes"]);

    const live = liveContact({ checked: ["subscribe"] });
    const off = run([live], [contactForm]);
    await off.tool("contact-submit").execute({ ...ok, subscribe: false });
    expect(names(off.submissions[0])).not.toContain("subscribe");
    const box = live._elements.find((c) => c.name === "subscribe") as Control;
    expect(box.events).toEqual(["input", "change"]);
  });

  it("radio selects the chosen option; an unknown option is refused", async () => {
    const good = run([liveContact()], [contactForm]);
    await good.tool("contact-submit").execute({ ...ok, plan: "pro" });
    expect(good.submissions[0].data.filter(([k]) => k === "plan")).toEqual([["plan", "pro"]]);

    const bad = run([liveContact()], [contactForm]);
    const r = await bad.tool("contact-submit").execute({ ...ok, plan: "gold" });
    expect(r.isError).toBe(true);
    expect(bad.submissions).toHaveLength(0);
  });

  it("a checkbox group ends with exactly the listed values checked", async () => {
    const { tool, submissions } = run([liveContact({ checked: ["a"] })], [contactForm]);
    await tool("contact-submit").execute({ ...ok, topics: ["b"] });
    expect(submissions[0].data.filter(([k]) => k === "topics")).toEqual([["topics", "b"]]);
  });

  it("refuses when a file is already selected", async () => {
    const file = new Control("file", "attachment", "", { files: [{ name: "x.txt" }] });
    const { tool, submissions } = run([liveContact({ extra: [file] })], [contactForm]);
    const r = await tool("contact-submit").execute(ok);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/file/);
    expect(submissions).toHaveLength(0);
  });

  it("an empty file input does not block", async () => {
    const file = new Control("file", "attachment");
    const { tool, submissions } = run([liveContact({ extra: [file] })], [contactForm]);
    const r = await tool("contact-submit").execute(ok);
    expect(r.isError).toBeUndefined();
    expect(submissions).toHaveLength(1);
  });

  it("refuses an invalid form and names the invalid control", async () => {
    const { tool, submissions } = run([liveContact()], [contactForm]);
    const r = await tool("contact-submit").execute({ name: "Ann" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("email");
    expect(submissions).toHaveLength(0);
  });

  it("refuses a live form that holds a password control", async () => {
    const pw = new Control("password", "pw", "secret");
    const { tool, submissions } = run([liveContact({ extra: [pw] })], [contactForm]);
    const r = await tool("contact-submit").execute(ok);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/password/);
    expect(submissions).toHaveLength(0);
  });

  it("finds and submits a form whose controls are named action, method, submit and elements", async () => {
    const live = liveContact({ shadow: true });
    const { tool, submissions } = run([live], [contactForm]);
    const r = await tool("contact-submit").execute(ok);
    expect(r.isError).toBeUndefined();
    expect(submissions).toHaveLength(1);
    expect(submissions[0].form).toBe(live);
  });

  it("picks the live form whose controls match every crawled field, not just the action", async () => {
    const termForm = new FakeForm("https://example.com/find", "get", [new Control("text", "term")]);
    const queryForm = new FakeForm("https://example.com/find", "get", [
      new Control("search", "query"),
    ]);
    const crawled: ExtractedForm[] = [
      {
        action: "/find",
        method: "get",
        fields: [{ name: "query", type: "search", required: false }],
      },
      { action: "/find", method: "get", fields: [{ name: "term", type: "text", required: false }] },
    ];
    const { tool, submissions } = run([termForm, queryForm], crawled);
    await tool("find").execute({ query: "x" });
    expect(submissions[0].form).toBe(queryForm);
    expect(submissions[0].data).toEqual([["query", "x"]]);
    await tool("find-2").execute({ term: "y" });
    expect(submissions[1].form).toBe(termForm);
  });

  it("matches by method and action: a different action or method is not found", async () => {
    const other = new FakeForm("https://example.com/elsewhere", "post", liveContact()._elements);
    const wrongMethod = new FakeForm(
      "https://example.com/contact-submit",
      "get",
      liveContact()._elements,
    );
    const { tool, submissions } = run([other, wrongMethod], [contactForm]);
    const r = await tool("contact-submit").execute(ok);
    expect(r.isError).toBe(true);
    expect(submissions).toHaveLength(0);
  });
});
