import { describe, expect, it } from "vitest";
import { formToolSpec, normalizeFormMethod } from "../src/generate/form-tools.js";
import { htmlToMarkdown } from "../src/generate/html-to-markdown.js";

const forms = (body: string) =>
  htmlToMarkdown(`<html><body><main>${body}</main></body></html>`, "https://example.com/").forms ??
  [];

describe("form extraction", () => {
  it.each([
    ["post", "POST"],
    ["POST", "POST"],
    ["get", "GET"],
    ["put", "GET"],
    ["", "GET"],
  ])("method %j becomes %s", (method, expected) => {
    const attr = method === "" ? "" : ` method="${method}"`;
    expect(forms(`<form action="/x"${attr}><input name="a"></form>`)[0].method).toBe(expected);
    expect(normalizeFormMethod(method || undefined)).toBe(expected);
  });

  it("drops dialog forms", () => {
    expect(forms(`<form action="/x" method="Dialog"><input name="a"></form>`)).toEqual([]);
    expect(normalizeFormMethod("dialog")).toBeNull();
  });

  it("drops a form with a named or unnamed password input", () => {
    expect(
      forms(
        `<form action="/x" method="post"><input name="u"><input name="p" type="password"></form>`,
      ),
    ).toEqual([]);
    expect(
      forms(`<form action="/x" method="post"><input name="u"><input type="PASSWORD"></form>`),
    ).toEqual([]);
  });

  it("merges radios with one name into one field, required if any is", () => {
    const [form] = forms(
      `<form action="/x"><input type="radio" name="plan" value="a"><input type="radio" name="plan" value="b" required><input type="radio" name="plan" value="a"></form>`,
    );
    expect(form.fields).toEqual([
      { name: "plan", type: "radio", required: true, options: ["a", "b"] },
    ]);
  });

  it("keeps the checkbox value (default on) and merges a same-name group", () => {
    const [single] = forms(
      `<form action="/x"><input type="checkbox" name="a" value="yes" aria-label="A"><input type="checkbox" name="b"></form>`,
    );
    expect(single.fields).toMatchObject([
      { name: "a", type: "checkbox", value: "yes", label: "A" },
      { name: "b", type: "checkbox", value: "on" },
    ]);
    const [group] = forms(
      `<form action="/x"><input type="checkbox" name="t" value="n"><input type="checkbox" name="t" value="d" required></form>`,
    );
    expect(group.fields).toEqual([
      { name: "t", type: "checkbox", required: true, options: ["n", "d"] },
    ]);
  });

  it("keeps only the first field for any other repeated name", () => {
    const [form] = forms(
      `<form action="/x"><input name="q" type="text"><input name="q" type="search" required><textarea name="q"></textarea></form>`,
    );
    expect(form.fields).toEqual([{ name: "q", type: "text", required: false }]);
  });

  it("includes controls outside the form that point at it with form=id", () => {
    const html = `<form id="f1" action="/x" method="post"><input name="a"></form><input name="b" form="f1"><input name="c" form="other">`;
    expect(forms(html)[0].fields.map((f) => f.name)).toEqual(["a", "b"]);
    expect(
      forms(
        `<form id="f1" action="/x" method="post"><input name="a"></form><input type="password" form="f1">`,
      ),
    ).toEqual([]);
  });

  it("keeps file inputs marked as file; consumers skip required ones", () => {
    const [form] = forms(
      `<form action="/x" method="post"><input name="t"><input name="f" type="file" required></form>`,
    );
    expect(form.fields.map((f) => f.type)).toEqual(["text", "file"]);
    expect(formToolSpec(form)).toBeNull();
    const [optional] = forms(
      `<form action="/x" method="post"><input name="t"><input name="f" type="file"></form>`,
    );
    expect(formToolSpec(optional)?.fields.map((f) => f.name)).toEqual(["t"]);
    const [onlyFile] = forms(`<form action="/x" method="post"><input name="f" type="file"></form>`);
    expect(formToolSpec(onlyFile)).toBeNull();
  });

  it("the shared rule also screens hand-built forms", () => {
    expect(
      formToolSpec({
        method: "post",
        fields: [
          { name: "u", type: "text", required: false },
          { name: "p", type: "password", required: false },
        ],
      }),
    ).toBeNull();
    expect(
      formToolSpec({
        method: "dialog",
        fields: [{ name: "u", type: "text", required: false }],
      }),
    ).toBeNull();
    expect(
      formToolSpec({
        method: "get",
        fields: [
          { name: "u", type: "text", required: false },
          { name: "u", type: "number", required: true },
        ],
      })?.fields,
    ).toHaveLength(1);
  });
});
