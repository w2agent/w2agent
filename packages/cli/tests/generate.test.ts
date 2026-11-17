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
    expect(formats).not.toContain("agents-md");
  });

  it("no --format given means all", () => {
    expect(parseFormats(undefined)).toEqual(parseFormats("all"));
    expect(parseFormats([])).toEqual(parseFormats("all"));
  });

  it("returns single format for named format", () => {
    expect(parseFormats("webmcp")).toEqual(["webmcp"]);
    expect(parseFormats(["llms-txt"])).toEqual(["llms-txt"]);
    expect(parseFormats("openclaw")).toEqual(["openclaw"]);
  });

  it("accepts a comma list", () => {
    expect(parseFormats(["llms-txt,full"])).toEqual(["llms-txt", "full"]);
  });

  it("accepts a repeated flag", () => {
    expect(parseFormats(["llms-txt", "full"])).toEqual(["llms-txt", "full"]);
  });

  it("accepts commas and repeats mixed, trimming whitespace", () => {
    expect(parseFormats(["llms-txt, full", "markdown"])).toEqual(["llms-txt", "full", "markdown"]);
  });

  it("dedupes preserving first-seen order", () => {
    expect(parseFormats(["full,llms-txt", "full", "llms-txt,faq"])).toEqual([
      "full",
      "llms-txt",
      "faq",
    ]);
  });

  it("combines all with an opt-in format", () => {
    const formats = parseFormats(["all,mcp-server"]);
    expect(formats).toEqual([...parseFormats("all"), "mcp-server"]);
    expect(parseFormats(["faq", "all"])[0]).toBe("faq");
    expect(parseFormats(["faq", "all"])).toHaveLength(parseFormats("all").length);
  });

  it("makes agents-md selectable", () => {
    expect(parseFormats("agents-md")).toEqual(["agents-md"]);
  });

  it("rejects an unknown value and lists the valid formats", () => {
    expect(() => parseFormats("bogus")).toThrow(/"bogus"/);
    try {
      parseFormats(["llms-txt,bogus"]);
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      for (const f of ["all", "llms-txt", "full", "agents-md", "mcp-server", "webmcp"]) {
        expect(msg).toContain(f);
      }
    }
  });

  it("rejects empty segments", () => {
    expect(() => parseFormats("llms-txt,,full")).toThrow(/empty/);
    expect(() => parseFormats("")).toThrow(/empty/);
    expect(() => parseFormats(["  "])).toThrow(/empty/);
  });
});
