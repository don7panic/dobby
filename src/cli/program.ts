import { Command } from "commander";
import { runConfigGetCommand, runConfigSetCommand, runConfigUnsetCommand } from "./commands/config.js";
import { runConfigureCommand } from "./commands/configure.js";
import { runDoctorCommand } from "./commands/doctor.js";
import {
  runExtensionInstallCommand,
  runExtensionListCommand,
  runExtensionUninstallCommand,
} from "./commands/extension.js";
import { runInitCommand } from "./commands/init.js";
import { runStartCommand } from "./commands/start.js";
import {
  DEFAULT_DISCORD_BOT_NAME,
} from "./shared/discord-config.js";
import { DEFAULT_CONFIG_PATH, resolveConfigPath } from "./shared/config-io.js";

/**
 * Adds the shared --config option with the global default path.
 */
function withConfigOption(command: Command): Command {
  return command.option("--config <path>", "Config path", DEFAULT_CONFIG_PATH);
}

/**
 * Builds the top-level dobby CLI program and registers all subcommands.
 */
export function buildProgram(): Command {
  const program = new Command();
  withConfigOption(program)
    .name("dobby")
    .description("Discord-first local agent gateway")
    .showHelpAfterError()
    .action(async (opts) => {
      await runStartCommand({ config: resolveConfigPath(opts.config as string | undefined) });
    });

  withConfigOption(
    program
    .command("start")
    .description("Start the gateway"),
  )
    .action(async (opts) => {
      await runStartCommand({ config: resolveConfigPath(opts.config as string | undefined) });
    });

  withConfigOption(
    program
    .command("init")
    .description("Initialize minimal runnable gateway config")
    .option("--preset <preset>", "Preset: discord-pi|discord-claude-cli", "discord-pi")
    .option("--project-root <path>", "Route project root", process.cwd())
    .option("--channel-id <id>", "Discord channel ID")
    .option("--route-id <id>", "Route ID", "main")
    .option("--bot-name <name>", "Discord bot name", DEFAULT_DISCORD_BOT_NAME)
    .option("--bot-token <token>", "Discord bot token")
    .option("--allow-all-messages", "Allow all group messages instead of mentions-only", false)
    .option("--merge", "Merge into existing config", false)
    .option("--overwrite", "Overwrite existing config", false)
    .option("--non-interactive", "Run without prompts", false)
    .option("--yes", "Assume yes for non-critical confirmations", false),
  )
    .action(async (opts) => {
      const initOptions = {
        config: resolveConfigPath(opts.config as string | undefined),
        preset: opts.preset as string,
        projectRoot: opts.projectRoot as string,
        routeId: opts.routeId as string,
        botName: opts.botName as string,
        ...(typeof opts.botToken === "string" ? { botToken: opts.botToken as string } : {}),
        allowAllMessages: Boolean(opts.allowAllMessages),
        merge: Boolean(opts.merge),
        overwrite: Boolean(opts.overwrite),
        nonInteractive: Boolean(opts.nonInteractive),
        yes: Boolean(opts.yes),
        ...(typeof opts.channelId === "string" ? { channelId: opts.channelId as string } : {}),
      };
      await runInitCommand({
        ...initOptions,
      });
    });

  withConfigOption(
    program
    .command("configure")
    .description("Interactive configuration wizard")
    .option(
      "--section <section>",
      "Config section (repeatable): provider|connector|routing|sandbox|data",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
  )
    .action(async (opts) => {
      await runConfigureCommand({
        config: resolveConfigPath(opts.config as string | undefined),
        sections: opts.section as string[],
      });
    });

  const configCommand = program.command("config").description("Get/set/unset config values by path");

  configCommand
    .command("get")
    .description("Get config value")
    .argument("<path>", "Path using dot or bracket notation")
    .option("--config <path>", "Config path", DEFAULT_CONFIG_PATH)
    .option("--json", "Output JSON", false)
    .action(async (path: string, opts) => {
      await runConfigGetCommand({
        config: resolveConfigPath(opts.config as string | undefined),
        path,
        json: Boolean(opts.json),
      });
    });

  configCommand
    .command("set")
    .description("Set config value")
    .argument("<path>", "Path using dot or bracket notation")
    .argument("<value>", "Value (JSON5 or raw string)")
    .option("--config <path>", "Config path", DEFAULT_CONFIG_PATH)
    .option("--strict-json", "Fail if value is not valid JSON5", false)
    .option("--no-validate", "Skip post-write validation", false)
    .action(async (path: string, value: string, opts) => {
      await runConfigSetCommand({
        config: resolveConfigPath(opts.config as string | undefined),
        path,
        value,
        strictJson: Boolean(opts.strictJson),
        noValidate: Boolean(opts.noValidate),
      });
    });

  configCommand
    .command("unset")
    .description("Remove config value")
    .argument("<path>", "Path using dot or bracket notation")
    .option("--config <path>", "Config path", DEFAULT_CONFIG_PATH)
    .option("--no-validate", "Skip post-write validation", false)
    .action(async (path: string, opts) => {
      await runConfigUnsetCommand({
        config: resolveConfigPath(opts.config as string | undefined),
        path,
        noValidate: Boolean(opts.noValidate),
      });
    });

  const extensionCommand = program.command("extension").description("Manage extensions");

  extensionCommand
    .command("install")
    .description("Install extension package")
    .argument("<packageSpec>", "npm package spec")
    .option("--config <path>", "Config path", DEFAULT_CONFIG_PATH)
    .option("--enable", "Enable extension in config after install", false)
    .option("--json", "Output JSON", false)
    .action(async (packageSpec: string, opts) => {
      await runExtensionInstallCommand({
        config: resolveConfigPath(opts.config as string | undefined),
        spec: packageSpec,
        enable: Boolean(opts.enable),
        json: Boolean(opts.json),
      });
    });

  extensionCommand
    .command("uninstall")
    .description("Uninstall extension package")
    .argument("<packageName>", "Package name")
    .option("--config <path>", "Config path", DEFAULT_CONFIG_PATH)
    .action(async (packageName: string, opts) => {
      await runExtensionUninstallCommand({
        config: resolveConfigPath(opts.config as string | undefined),
        packageName,
      });
    });

  extensionCommand
    .command("list")
    .description("List installed extension packages")
    .option("--config <path>", "Config path", DEFAULT_CONFIG_PATH)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runExtensionListCommand({
        config: resolveConfigPath(opts.config as string | undefined),
        json: Boolean(opts.json),
      });
    });

  withConfigOption(
    program
    .command("doctor")
    .description("Validate configuration and common runtime risks")
    .option("--fix", "Apply conservative fixes", false),
  )
    .action(async (opts) => {
      await runDoctorCommand({
        config: resolveConfigPath(opts.config as string | undefined),
        fix: Boolean(opts.fix),
      });
    });

  return program;
}
