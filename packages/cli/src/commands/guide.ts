import { GUIDES, type PlatformId } from "@w2agent/core";
import { Argument, type Command } from "commander";
import { enterJsonMode, failWith, jsonRequested } from "../agent/output.js";
import { VALID_PLATFORMS } from "./integrate-support.js";

const GENERIC_SECTIONS = [
  "Passes when",
  "Who fixes it",
  "Fix (any framework)",
  "Pitfalls",
  "Verify",
];

const PLATFORM_SECTIONS: Partial<Record<PlatformId, string>> = {
  nextjs: "Next.js (App Router)",
};

export const GUIDE_IDS: readonly string[] = GUIDES.map((g) => g.id);

interface Block {
  heading: string | null;
  text: string;
}

function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = [{ heading: null, text: "" }];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) {
      blocks.push({ heading: line.slice(3).trim(), text: "" });
    }
    blocks[blocks.length - 1].text += `${line}\n`;
  }
  return blocks;
}

export function renderGuide(markdown: string, platform: PlatformId | undefined): string {
  if (platform === undefined) return markdown;
  const section = PLATFORM_SECTIONS[platform];
  const blocks = splitBlocks(markdown);
  const hasSection = blocks.some((b) => b.heading !== null && b.heading === section);
  const kept = blocks.filter(
    (b) => b.heading === null || GENERIC_SECTIONS.includes(b.heading) || b.heading === section,
  );
  const body = kept
    .map((b) => b.text)
    .join("")
    .replace(/\n+$/, "\n");
  return hasSection
    ? body
    : `${body}\nNo ${platform} section exists in this guide. The steps above apply to any framework.\n`;
}

export function registerGuideCommand(program: Command): void {
  const idArgument = new Argument("<guide-id>", `Guide id: ${GUIDE_IDS.join(", ")}`);
  // Set for `schema` only: .choices() would throw before the action runs and
  // index.ts would report invalid_argument instead of unknown_guide.
  idArgument.argChoices = [...GUIDE_IDS];

  program
    .command("guide")
    .description("Print the fix guide for a failing check (the audit result names it)")
    .addArgument(idArgument)
    .option("-p, --platform <platform>", `Add the framework section: ${VALID_PLATFORMS.join(", ")}`)
    .option("--json", "Print one JSON document on stdout (the guide, or an error envelope)")
    .action(async (id: string, opts: { platform?: string }) => {
      const json = jsonRequested() ? enterJsonMode() : undefined;
      try {
        const guide = GUIDES.find((g) => g.id === id);
        if (!guide) {
          await failWith(json, {
            reason: "unknown_guide",
            message: `Unknown guide: ${id}. Valid ids: ${GUIDE_IDS.join(", ")}`,
            next: [["w2agent", "schema"]],
          });
          return;
        }
        if (opts.platform !== undefined && !VALID_PLATFORMS.includes(opts.platform as PlatformId)) {
          await failWith(json, {
            reason: "invalid_argument",
            message: `Unknown platform: ${opts.platform}. Valid options: ${VALID_PLATFORMS.join(", ")}`,
            next: [["w2agent", "schema"]],
          });
          return;
        }
        const platform = opts.platform as PlatformId | undefined;
        const markdown = renderGuide(guide.markdown, platform);
        if (json) {
          await json.emit({
            ok: true,
            id: guide.id,
            checks: guide.checks,
            fixBy: guide.fixBy,
            platform: platform ?? null,
            markdown,
          });
        } else {
          process.stdout.write(markdown);
        }
      } finally {
        json?.restore();
      }
    });
}
