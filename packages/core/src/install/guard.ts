import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { InstallAction } from "./types.js";

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

export interface GuardResult {
  actions: InstallAction[];
  warnings: string[];
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export type DestProblem = "outside" | "not-directory" | "unresolvable";

type AncestorResult = { real: string } | { problem: "not-directory" | "unresolvable" };

function realpathOfNearestAncestor(path: string): AncestorResult {
  let current = path;
  for (;;) {
    try {
      lstatSync(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return { problem: "unresolvable" };
      const parent = dirname(current);
      if (parent === current) return { problem: "unresolvable" };
      current = parent;
      continue;
    }
    try {
      const real = realpathSync(current);
      return statSync(real).isDirectory() ? { real } : { problem: "not-directory" };
    } catch {
      return { problem: "unresolvable" };
    }
  }
}

export function checkDestination(projectDir: string, dest: string): DestProblem | null {
  if (!dest || isAbsolute(dest)) return "outside";
  const root = resolve(projectDir);
  const target = resolve(root, dest);
  if (!isInside(root, target)) return "outside";

  const realRoot = realpathOfNearestAncestor(root);
  const realAncestor = realpathOfNearestAncestor(dirname(target));
  if ("problem" in realRoot) return "unresolvable";
  if ("problem" in realAncestor) return realAncestor.problem;
  return realAncestor.real === realRoot.real || isInside(realRoot.real, realAncestor.real)
    ? null
    : "outside";
}

export function describeDestProblem(problem: DestProblem): string {
  switch (problem) {
    case "outside":
      return "outside the project directory";
    case "not-directory":
      return "a parent path is not a directory";
    case "unresolvable":
      return "a parent path cannot be resolved (broken symlink or unreadable)";
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function findCodeSibling(target: string): string | null {
  const ext = extname(target);
  if (!CODE_EXTENSIONS.includes(ext)) return null;
  const stem = basename(target, ext);
  let entries: string[];
  try {
    entries = readdirSync(dirname(target));
  } catch {
    return null;
  }
  return (
    entries.find((name) => {
      const otherExt = extname(name);
      return (
        otherExt !== ext && CODE_EXTENSIONS.includes(otherExt) && basename(name, otherExt) === stem
      );
    }) ?? null
  );
}

export function guardInstallActions(actions: InstallAction[], projectDir: string): GuardResult {
  const warnings: string[] = [];
  const guarded = actions.map((action): InstallAction => {
    if (action.type !== "write") return action;

    const problem = checkDestination(projectDir, action.dest);
    if (problem) {
      const what = describeDestProblem(problem);
      warnings.push(`${action.dest} was not written: ${what}.`);
      return { type: "skip", dest: action.dest, reason: `${what}, not written` };
    }

    const target = resolve(projectDir, action.dest);
    const stat = lstatOrNull(target);
    if (stat) {
      if (stat.isFile()) {
        try {
          if (readFileSync(target).equals(Buffer.from(action.content ?? "", "utf-8"))) {
            return { type: "skip", dest: action.dest, reason: "already up to date" };
          }
        } catch {}
      }
      warnings.push(
        `${action.dest} already exists and was not overwritten. Remove it and re-run to replace it.`,
      );
      return {
        type: "skip",
        dest: action.dest,
        reason: "already exists, not overwritten (remove it and re-run to replace it)",
      };
    }

    const sibling = findCodeSibling(target);
    if (sibling) {
      warnings.push(
        `${action.dest} was not written because ${sibling} already exists next to it. Remove one of them and re-run to replace it.`,
      );
      return {
        type: "skip",
        dest: action.dest,
        reason: `${sibling} already exists next to it, not written`,
      };
    }

    return action;
  });

  return { actions: guarded, warnings };
}
