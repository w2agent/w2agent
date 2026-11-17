import { beforeEach, describe, expect, it, vi } from "vitest";
import indexMd from "../src/runtime/server/routes/index-md";
import llmsFullTxt from "../src/runtime/server/routes/llms-full-txt";
import llmsTxt from "../src/runtime/server/routes/llms-txt";
import { setAssets, storageBases } from "./stubs/imports";

function makeEvent() {
  const setHeader = vi.fn();
  return { event: { node: { res: { setHeader } } } as never, setHeader };
}

const CASES = [
  { name: "/llms.txt", route: llmsTxt, file: "llms.txt", type: "text/plain; charset=utf-8" },
  {
    name: "/llms-full.txt",
    route: llmsFullTxt,
    file: "llms-full.txt",
    type: "text/plain; charset=utf-8",
  },
  { name: "/index.md", route: indexMd, file: "llms.txt", type: "text/markdown; charset=utf-8" },
] as const;

describe.each(CASES)("Nitro $name handler", ({ route, file, type }) => {
  beforeEach(() => {
    setAssets({});
    storageBases.length = 0;
  });

  it("serves the build-time asset with its content type and cache header", async () => {
    setAssets({ [file]: "# Marker\n" });
    const { event, setHeader } = makeEvent();
    expect(await route(event)).toBe("# Marker\n");
    expect(setHeader).toHaveBeenCalledWith("Content-Type", type);
    expect(setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      expect.stringContaining("max-age=3600"),
    );
    expect(storageBases).toContain("assets:w2agent");
  });

  it("responds 404 with no public cache header and no placeholder body when the asset is absent", async () => {
    const { event, setHeader } = makeEvent();
    let thrown: unknown;
    try {
      await route(event);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ statusCode: 404 });
    expect(setHeader).not.toHaveBeenCalled();
  });
});
