import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import * as fs from "node:fs";
import { GET as fullGet } from "../src/routes/llms-full-txt";
import { GET as llmsGet } from "../src/routes/llms-txt";

const mockFs = vi.mocked(fs);

const routes: Array<[string, string, () => Response]> = [
  ["/llms.txt", "public/llms.txt", llmsGet as unknown as () => Response],
  ["/llms-full.txt", "public/llms-full.txt", fullGet as unknown as () => Response],
];

describe.each(routes)("SSR %s route", (_name, file, handler) => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 404 with no public cache header and no placeholder body when the file is absent", async () => {
    mockFs.existsSync.mockReturnValue(false);
    const res = handler();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(await res.text()).not.toContain("w2agent generate");
  });

  it("serves the file with a cache header when present", async () => {
    mockFs.existsSync.mockImplementation((p) => String(p).endsWith(file));
    mockFs.readFileSync.mockReturnValue("# real\n" as never);
    const res = handler();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
    expect(await res.text()).toBe("# real\n");
  });
});
