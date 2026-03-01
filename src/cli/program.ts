import { Command } from "commander";
import {
  runConfigEditCommand,
  runConfigListCommand,
  runConfigSchemaListCommand,
  runConfigSchemaShowCommand,
  runConfigShowCommand,
} from "./commands/config.js";
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
  runBotListCommand,
  runBotSetCommand,
  runChannelListCommand,
  runChannelSetCommand,
  runChannelUnsetCommand,
  runRouteListCommand,
  runRouteRemoveCommand,
  runRouteSetCommand,
} from "./commands/topology.js";
import { DEFAULT_DISCORD_CONNECTOR_INSTANCE_ID } from "./shared/discord-config.js";

/**
 * Builds the top-level dobby CLI program and registers all subcommands.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("dobby")
    .description("Discord-first local agent gateway")
    .showHelpAfterError()
    .action(async () => {
      await runStartCommand();
    });

  program
    .command("start")
    .description("Start the gateway")
    .action(async () => {
      await runStartCommand();
    });

  program
    .command("init")
    .description("Initialize minimal runnable gateway config")
    .action(async () => {
      await runInitCommand();
    });

  program
    .command("configure")
    .description("Interactive configuration wizard")
    .option(
      "--section <section>",
      "Config section (repeatable): provider|connector|routing|sandbox|data",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (opts) => {
      await runConfigureCommand({
        sections: opts.section as string[],
      });
    });

  const botCommand = program.command("bot").description("Manage bot connector settings");

  botCommand
    .command("list")
    .description("List configured bot connectors")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runBotListCommand({
        json: Boolean(opts.json),
      });
    });

  botCommand
    .command("set")
    .description("Update one bot connector")
    .argument("<connectorId>", "Connector instance ID")
    .option("--name <name>", "Discord botName")
    .option("--token <token>", "Discord botToken")
    .action(async (connectorId: string, opts) => {
      await runBotSetCommand({
        connectorId,
        ...(typeof opts.name === "string" ? { name: opts.name as string } : {}),
        ...(typeof opts.token === "string" ? { token: opts.token as string } : {}),
      });
    });

  const channelCommand = program.command("channel").description("Manage Discord channel-route mappings");

  channelCommand
    .command("list")
    .description("List channel mappings")
    .option("--connector <id>", "Filter by connector instance ID")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelListCommand({
        ...(typeof opts.connector === "string" ? { connectorId: opts.connector as string } : {}),
        json: Boolean(opts.json),
      });
    });

  channelCommand
    .command("set")
    .description("Create or update one channel mapping")
    .argument("<channelId>", "Discord channel ID")
    .argument("<routeId>", "Route ID")
    .option("--connector <id>", "Connector instance ID", DEFAULT_DISCORD_CONNECTOR_INSTANCE_ID)
    .action(async (channelId: string, routeId: string, opts) => {
      await runChannelSetCommand({
        connectorId: opts.connector as string,
        channelId,
        routeId,
      });
    });

  channelCommand
    .command("unset")
    .description("Remove one channel mapping")
    .argument("<channelId>", "Discord channel ID")
    .option("--connector <id>", "Connector instance ID", DEFAULT_DISCORD_CONNECTOR_INSTANCE_ID)
    .action(async (channelId: string, opts) => {
      await runChannelUnsetCommand({
        connectorId: opts.connector as string,
        channelId,
      });
    });

  const routeCommand = program.command("route").description("Manage routing profiles");

  routeCommand
    .command("list")
    .description("List route profiles")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runRouteListCommand({
        json: Boolean(opts.json),
      });
    });

  routeCommand
    .command("set")
    .description("Create or update one route")
    .argument("<routeId>", "Route ID")
    .option("--project-root <path>", "Route project root")
    .option("--tools <profile>", "Route tools profile: full|readonly")
    .option("--provider-id <id>", "Provider instance ID")
    .option("--sandbox-id <id>", "Sandbox instance ID")
    .option("--mentions-only <boolean>", "Whether group chats require @mention: true|false")
    .option("--default", "Set as routing.defaultRouteId", false)
    .action(async (routeId: string, opts) => {
      const mentionsOnly =
        typeof opts.mentionsOnly === "string"
          ? opts.mentionsOnly.trim().toLowerCase() === "true"
          : undefined;
      if (
        typeof opts.mentionsOnly === "string"
        && opts.mentionsOnly.trim().toLowerCase() !== "true"
        && opts.mentionsOnly.trim().toLowerCase() !== "false"
      ) {
        throw new Error("--mentions-only must be true or false");
      }

      await runRouteSetCommand({
        routeId,
        ...(typeof opts.projectRoot === "string" ? { projectRoot: opts.projectRoot as string } : {}),
        ...(typeof opts.tools === "string" ? { tools: opts.tools as string } : {}),
        ...(typeof opts.providerId === "string" ? { providerId: opts.providerId as string } : {}),
        ...(typeof opts.sandboxId === "string" ? { sandboxId: opts.sandboxId as string } : {}),
        ...(mentionsOnly !== undefined ? { allowMentionsOnly: mentionsOnly } : {}),
        setAsDefault: Boolean(opts.default),
      });
    });

  routeCommand
    .command("remove")
    .description("Remove one route")
    .argument("<routeId>", "Route ID")
    .option("--cascade-channel-maps", "Remove channel mappings that reference this route", false)
    .action(async (routeId: string, opts) => {
      await runRouteRemoveCommand({
        routeId,
        cascadeChannelMaps: Boolean(opts.cascadeChannelMaps),
      });
    });

  const configCommand = program.command("config").description("Inspect and edit config");

  configCommand
    .command("show")
    .description("Show full config or one section")
    .argument("[section]", "Section: providers|connectors|routing|sandboxes|data|extensions")
    .option("--json", "Output JSON", false)
    .action(async (section: string | undefined, opts) => {
      await runConfigShowCommand({
        ...(typeof section === "string" ? { section } : {}),
        json: Boolean(opts.json),
      });
    });

  configCommand
    .command("list")
    .description("List config keys with type and preview")
    .argument("[section]", "Section: providers|connectors|routing|sandboxes|data|extensions")
    .option("--json", "Output JSON", false)
    .action(async (section: string | undefined, opts) => {
      await runConfigListCommand({
        ...(typeof section === "string" ? { section } : {}),
        json: Boolean(opts.json),
      });
    });

  configCommand
    .command("edit")
    .description("Interactive edit for high-frequency sections")
    .option(
      "--section <section>",
      "Edit section (repeatable): provider|connector|routing",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (opts) => {
      await runConfigEditCommand({
        sections: opts.section as string[],
      });
    });

  const configSchemaCommand = configCommand.command("schema").description("Inspect extension config schemas");

  configSchemaCommand
    .command("list")
    .description("List loaded contributions and schema availability")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runConfigSchemaListCommand({
        json: Boolean(opts.json),
      });
    });

  configSchemaCommand
    .command("show")
    .description("Show one contribution config schema")
    .argument("<contributionId>", "Contribution ID")
    .option("--json", "Output JSON", false)
    .action(async (contributionId: string, opts) => {
      await runConfigSchemaShowCommand({
        contributionId,
        json: Boolean(opts.json),
      });
    });

  const extensionCommand = program.command("extension").description("Manage extensions");

  extensionCommand
    .command("install")
    .description("Install extension package")
    .argument("<packageSpec>", "npm package spec")
    .option("--enable", "Enable extension in config after install", false)
    .option("--json", "Output JSON", false)
    .action(async (packageSpec: string, opts) => {
      await runExtensionInstallCommand({
        spec: packageSpec,
        enable: Boolean(opts.enable),
        json: Boolean(opts.json),
      });
    });

  extensionCommand
    .command("uninstall")
    .description("Uninstall extension package")
    .argument("<packageName>", "Package name")
    .action(async (packageName: string) => {
      await runExtensionUninstallCommand({
        packageName,
      });
    });

  extensionCommand
    .command("list")
    .description("List installed extension packages")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runExtensionListCommand({
        json: Boolean(opts.json),
      });
    });

  program
    .command("doctor")
    .description("Validate configuration and common runtime risks")
    .option("--fix", "Apply conservative fixes", false)
    .action(async (opts) => {
      await runDoctorCommand({
        fix: Boolean(opts.fix),
      });
    });

  return program;
}
