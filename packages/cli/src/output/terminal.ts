import chalk from "chalk";
import type { AuditReport, CategoryResult, LetterGrade } from "@w2agent/core";

const FILLED = "█";
const EMPTY = "░";
const BAR_WIDTH = 10;

function gradeColor(grade: LetterGrade): typeof chalk {
  switch (grade) {
    case "A": return chalk.green;
    case "B": return chalk.greenBright;
    case "C": return chalk.yellow;
    case "D": return chalk.hex("#FFA500");
    case "F": return chalk.red;
  }
}

function scoreColor(score: number): typeof chalk {
  if (score >= 90) return chalk.green;
  if (score >= 80) return chalk.greenBright;
  if (score >= 70) return chalk.yellow;
  if (score >= 60) return chalk.hex("#FFA500");
  return chalk.red;
}

function progressBar(score: number): string {
  const filled = Math.round((score / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const color = scoreColor(score);
  return color(FILLED.repeat(filled)) + chalk.gray(EMPTY.repeat(empty));
}

function padRight(str: string, len: number): string {
  return str + " ".repeat(Math.max(0, len - str.length));
}

export function formatReport(report: AuditReport): string {
  const lines: string[] = [];
  const color = gradeColor(report.grade);

  lines.push("");
  lines.push(chalk.bold("  w2agent audit — AI Readiness Report"));
  lines.push(chalk.gray("  " + "─".repeat(36)));
  lines.push("");
  lines.push(`  URL: ${chalk.cyan(report.url)}`);
  lines.push(`  Pages scanned: ${report.pagesScanned}`);
  lines.push(`  Time: ${(report.duration / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push(`  Overall Score: ${color.bold(`${report.overallScore}/100`)} (${color.bold(report.grade)})`);
  lines.push("");

  for (const category of report.categories) {
    const bar = progressBar(category.score);
    const name = padRight(category.name, 24);
    lines.push(`  ${name} ${bar}  ${scoreColor(category.score)(`${category.score}/100`)}`);
  }

  if (report.topIssues.length > 0) {
    lines.push("");
    lines.push(chalk.bold("  Top Issues:"));
    for (const issue of report.topIssues) {
      const points = chalk.gray(`(+${issue.pointsIfFixed} points if fixed)`);
      lines.push(`  ${chalk.red("✗")} ${issue.message}  ${points}`);
    }
  }

  lines.push("");
  lines.push(chalk.gray("  Fix these with: ") + chalk.cyan("w2agent generate <url>"));
  lines.push("");

  return lines.join("\n");
}

export function formatVerboseReport(report: AuditReport): string {
  const lines: string[] = [formatReport(report)];

  lines.push(chalk.bold("  Detailed Results:"));
  lines.push("");

  for (const category of report.categories) {
    lines.push(`  ${chalk.bold(category.name)} — ${scoreColor(category.score)(`${category.score}/100`)}`);
    for (const check of category.checks) {
      const icon = check.status === "pass" ? chalk.green("✓") :
                   check.status === "partial" ? chalk.yellow("~") :
                   check.status === "skip" ? chalk.gray("-") :
                   chalk.red("✗");
      lines.push(`    ${icon} ${padRight(check.name, 40)} ${scoreColor(check.score)(`${check.score}`)}`);
      if (check.status !== "pass" && check.message) {
        lines.push(`      ${chalk.gray(check.message)}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
