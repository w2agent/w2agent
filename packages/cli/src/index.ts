#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { argvHasJson, buildErrorEnvelope, currentArgv, EXIT } from "./agent/output.js";
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

const program = new Command();

program
  .name("w2agent")
  .description("Agentize the web — audit, score, and deploy websites as AI agents")
  .version(version)
  .exitOverride()
  .configureOutput({
    outputError: (str, write) => {
      if (!jsonRequested) write(str);
    },
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
