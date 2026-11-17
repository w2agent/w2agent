import type { Command, Option } from "commander";

interface OptionSchema {
  flags: string;
  long: string | null;
  short: string | null;
  description: string;
  default: unknown;
  takesValue: boolean;
  required: boolean;
  repeatable?: true;
}

interface CommandSchema {
  name: string;
  description: string;
  arguments: {
    name: string;
    required: boolean;
    variadic: boolean;
    description: string;
    choices?: string[];
  }[];
  options: OptionSchema[];
  commands?: CommandSchema[];
}

function describeOption(opt: Option): OptionSchema {
  const repeatable = opt.variadic || Array.isArray(opt.defaultValue);
  return {
    flags: opt.flags,
    long: opt.long ?? null,
    short: opt.short ?? null,
    description: opt.description,
    default: opt.defaultValue ?? null,
    takesValue: Boolean(opt.required || opt.optional),
    required: opt.mandatory,
    ...(repeatable ? { repeatable: true as const } : {}),
  };
}

function describeCommand(cmd: Command): CommandSchema {
  return {
    name: cmd.name(),
    description: cmd.description(),
    arguments: cmd.registeredArguments.map((arg) => ({
      name: arg.name(),
      required: arg.required,
      variadic: arg.variadic,
      description: arg.description,
      ...(arg.argChoices ? { choices: [...arg.argChoices] } : {}),
    })),
    options: cmd.options.map(describeOption),
    ...(cmd.commands.length > 0 ? { commands: cmd.commands.map(describeCommand) } : {}),
  };
}

export function buildSchema(program: Command) {
  return {
    name: program.name(),
    version: program.version() ?? "",
    options: program.options.map(describeOption),
    commands: program.commands.map(describeCommand),
  };
}

export function registerSchemaCommand(program: Command): void {
  program
    .command("schema")
    .description("Print the command tree (arguments and options) as JSON")
    .option("--json", "Accepted for consistency; the output is always JSON")
    .action(() => {
      console.log(JSON.stringify(buildSchema(program), null, 2));
    });
}
