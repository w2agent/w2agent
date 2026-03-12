import { describe, expect, it } from "vitest";
import { parseFormats } from "../src/commands/generate.js";

describe("parseFormats", () => {
  it("all includes webmcp and standard formats", () => {
    const formats = parseFormats("all");
    expect(formats).toContain("webmcp");
    expect(formats).toContain("llms-txt");
    expect(formats).toContain("full");
    expect(formats).toContain("markdown");
    expect(formats).toContain("robots-txt");
    expect(formats).toContain("schema-org");
    expect(formats).toContain("agent-card");
    expect(formats).toContain("faq");
  });

  it("all does not include opt-in formats", () => {
    const formats = parseFormats("all");
    expect(formats).not.toContain("mcp-server");
    expect(formats).not.toContain("skill-md");
    expect(formats).not.toContain("openclaw");
  });

  it("returns single format for named format", () => {
    expect(parseFormats("webmcp")).toEqual(["webmcp"]);
    expect(parseFormats("llms-txt")).toEqual(["llms-txt"]);
    expect(parseFormats("openclaw")).toEqual(["openclaw"]);
  });
});
