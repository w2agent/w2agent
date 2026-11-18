#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import {
  apiKeyValues,
  argvHasJson,
  buildErrorEnvelope,
  currentArgv,
  EXIT,
  installOutputRedaction,
  redactMessage,
} from "./agent/output.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerAgentizeCommand, registerDeployCommand } from "./commands/deploy.js";
import { registerGenerateCommand } from "./commands/generate.js";
import { registerGuideCommand } from "./commands/guide.js";
import { registerIntegrateCommand } from "./commands/integrate.js";
import {
  registerLoginCommand,
  registerLogoutCommand,
  registerWhoamiCommand,
} from "./commands/login.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerSchemaCommand } from "./commands/schema.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

const jsonRequested = argvHasJson(process.argv.slice(2));

// Help and version text prints no argv value, so it bypasses the scrubber. Under
// --json stdout is one document that buildErrorEnvelope already redacts, so only
// stderr is scrubbed there.
const rawStdoutWrite = process.stdout.write.bind(process.stdout);
installOutputRedaction(
  apiKeyValues(currentArgv()),
  jsonRequested ? [process.stderr] : [process.stdout, process.stderr],
);

const program = new Command();

program
  .name("w2agent")
  .description("Agentize the web — audit, score, and deploy websites as AI agents")
  .version(version)
  .exitOverride()
  .configureOutput({
    writeOut: (str) => {
      rawStdoutWrite(str);
    },
    outputError: (str, write) => {
      if (!jsonRequested) write(redactMessage(str, apiKeyValues(currentArgv())));
    },
  });

program.hook("preAction", (_program, actionCommand) => {
  for (const option of actionCommand.options) {
    const value: unknown = actionCommand.getOptionValue(option.attributeName());
    const values = Array.isArray(value) ? value : [value];
    const swallowed = values.some(
      (v) =>
        typeof v === "string" &&
        (v === "--api-key" || v === "--token" || /^--(api-key|token)=/.test(v)),
    );
    if (swallowed) {
      actionCommand.error(
        `error: ${option.long ?? option.flags} took a secret flag (--api-key/--token) as its value. Give ${option.long ?? option.flags} a value.`,
        { exitCode: EXIT.usage, code: "w2agent.secretFlagAsValue" },
      );
    }
  }
});

registerAuditCommand(program);
registerAgentizeCommand(program);
registerDeployCommand(program);
registerGenerateCommand(program);
registerGuideCommand(program);
registerIntegrateCommand(program);
registerMcpCommand(program);
registerLoginCommand(program);
registerLogoutCommand(program);
registerWhoamiCommand(program);
registerSchemaCommand(program);

function finish(code: number, document?: unknown): void {
  process.exitCode = code;
  if (document !== undefined) process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CommanderError) {
    const passthrough = ["commander.helpDisplayed", "commander.version", "commander.help"];
    if (passthrough.includes(err.code)) {
      finish(err.exitCode);
    } else {
      const message = err.message.replace(/^error: /, "");
      finish(
        EXIT.usage,
        jsonRequested
          ? buildErrorEnvelope(
              { reason: "invalid_argument", message, next: [["w2agent", "schema"]] },
              currentArgv(),
            )
          : undefined,
      );
    }
  } else {
    const message = err instanceof Error ? err.message : String(err);
    if (jsonRequested) {
      finish(
        EXIT.operational,
        buildErrorEnvelope({ reason: "unknown_failure", message }, currentArgv()),
      );
    } else {
      console.error(message);
      finish(EXIT.operational);
    }
  }
}
