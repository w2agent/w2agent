#!/usr/bin/env node

import { Command } from "commander";
import { registerAuditCommand } from "./commands/audit.js";

const program = new Command();

program
  .name("w2agent")
  .description("AI agent readiness toolkit for the web")
  .version("0.1.0");

registerAuditCommand(program);

program.parse();
