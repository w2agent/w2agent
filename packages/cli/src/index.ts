#!/usr/bin/env node

import { Command } from "commander";
import { registerAuditCommand } from "./commands/audit.js";
import { registerAgentizeCommand, registerDeployCommand } from "./commands/deploy.js";
import { registerGenerateCommand } from "./commands/generate.js";
import { registerIntegrateCommand } from "./commands/integrate.js";
import {
  registerLoginCommand,
  registerLogoutCommand,
  registerWhoamiCommand,
} from "./commands/login.js";
import { registerMcpCommand } from "./commands/mcp.js";

const program = new Command();

program
  .name("w2agent")
  .description("Agentize the web — audit, score, and deploy websites as AI agents")
  .version("0.1.0");

registerAuditCommand(program);
registerAgentizeCommand(program);
registerDeployCommand(program);
registerGenerateCommand(program);
registerIntegrateCommand(program);
registerMcpCommand(program);
registerLoginCommand(program);
registerLogoutCommand(program);
registerWhoamiCommand(program);

program.parse();
