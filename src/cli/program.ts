import { Command } from "commander";
import {
  runConfigEditCommand,
  runConfigListCommand,
  runConfigSchemaListCommand,
  runConfigSchemaShowCommand,
  runConfigShowCommand,
} from "./commands/config.js";
import { runConfigureCommand } from "./commands/configure.js";
import {
  runCronAddCommand,
  runCronListCommand,
  runCronPauseCommand,
  runCronRemoveCommand,
  runCronResumeCommand,
  runCronRunCommand,
  runCronStatusCommand,
  runCronUpdateCommand,
} from "./commands/cron.js";
import { runDoctorCommand } from "./commands/doctor.js";
import {
  runExtensionInstallCommand,
  runExtensionListCommand,
  runExtensionUninstallCommand,
} from "./commands/extension.js";
import { runInitCommand } from "./commands/init.js";
import { runStartCommand } from "./commands/start.js";
import {
  runBindingListCommand,
  runBindingRemoveCommand,
  runBindingSetCommand,
  runBotListCommand,
  runBotSetCommand,
  runRouteListCommand,
  runRouteRemoveCommand,
  runRouteSetCommand,
} from "./commands/topology.js";

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
      "Config section (repeatable): provider|connector|route|binding|sandbox|data",
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

  const bindingCommand = program.command("binding").description("Manage connector source-route bindings");

  bindingCommand
    .command("list")
    .description("List bindings")
    .option("--connector <id>", "Filter by connector instance ID")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runBindingListCommand({
        ...(typeof opts.connector === "string" ? { connectorId: opts.connector as string } : {}),
        json: Boolean(opts.json),
      });
    });

  bindingCommand
    .command("set")
    .description("Create or update one binding")
    .argument("<bindingId>", "Binding ID")
    .requiredOption("--connector <id>", "Connector instance ID")
    .requiredOption("--source-type <type>", "Source type: channel|chat")
    .requiredOption("--source-id <id>", "Source ID")
    .requiredOption("--route <id>", "Route ID")
    .action(async (bindingId: string, opts) => {
      if (opts.sourceType !== "channel" && opts.sourceType !== "chat") {
        throw new Error("--source-type must be channel or chat");
      }

      await runBindingSetCommand({
        bindingId,
        connectorId: opts.connector as string,
        sourceType: opts.sourceType as "channel" | "chat",
        sourceId: opts.sourceId as string,
        routeId: opts.route as string,
      });
    });

  bindingCommand
    .command("remove")
    .description("Remove one binding")
    .argument("<bindingId>", "Binding ID")
    .action(async (bindingId: string) => {
      await runBindingRemoveCommand({
        bindingId,
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
    .option("--provider <id>", "Provider instance ID")
    .option("--sandbox <id>", "Sandbox instance ID")
    .option("--mentions <policy>", "Mention policy: required|optional")
    .action(async (routeId: string, opts) => {
      if (
        typeof opts.mentions === "string"
        && opts.mentions !== "required"
        && opts.mentions !== "optional"
      ) {
        throw new Error("--mentions must be required or optional");
      }

      await runRouteSetCommand({
        routeId,
        ...(typeof opts.projectRoot === "string" ? { projectRoot: opts.projectRoot as string } : {}),
        ...(typeof opts.tools === "string" ? { tools: opts.tools as string } : {}),
        ...(typeof opts.provider === "string" ? { providerId: opts.provider as string } : {}),
        ...(typeof opts.sandbox === "string" ? { sandboxId: opts.sandbox as string } : {}),
        ...(typeof opts.mentions === "string" ? { mentions: opts.mentions as "required" | "optional" } : {}),
      });
    });

  routeCommand
    .command("remove")
    .description("Remove one route")
    .argument("<routeId>", "Route ID")
    .option("--cascade-bindings", "Remove bindings that reference this route", false)
    .action(async (routeId: string, opts) => {
      await runRouteRemoveCommand({
        routeId,
        cascadeBindings: Boolean(opts.cascadeBindings),
      });
    });

  const configCommand = program.command("config").description("Inspect and edit config");

  configCommand
    .command("show")
    .description("Show full config or one section")
    .argument("[section]", "Section: providers|connectors|routes|bindings|sandboxes|data|extensions")
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
    .argument("[section]", "Section: providers|connectors|routes|bindings|sandboxes|data|extensions")
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
      "Edit section (repeatable): provider|connector|route|binding",
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

  const cronCommand = program.command("cron").description("Manage scheduled cron jobs");

  cronCommand
    .command("add")
    .description("Create one cron job")
    .argument("<name>", "Job name")
    .requiredOption("--prompt <text>", "Prompt text for each run")
    .requiredOption("--connector <id>", "Connector instance ID")
    .requiredOption("--route <id>", "Route ID")
    .requiredOption("--channel <id>", "Delivery channel/chat ID")
    .option("--thread <id>", "Delivery thread ID")
    .option("--session-policy <policy>", "Session policy: stateless|shared-session", "stateless")
    .option("--at <iso>", "Run once at ISO timestamp")
    .option("--every-ms <ms>", "Run at fixed interval in milliseconds")
    .option("--cron <expr>", "Cron expression")
    .option("--tz <tz>", "Timezone for cron expression")
    .option("--cron-config <path>", "Override cron config path")
    .action(async (name: string, opts) => {
      const parsedEveryMs = typeof opts.everyMs === "string" ? Number(opts.everyMs) : null;
      await runCronAddCommand({
        name,
        prompt: opts.prompt as string,
        connectorId: opts.connector as string,
        routeId: opts.route as string,
        channelId: opts.channel as string,
        ...(typeof opts.thread === "string" ? { threadId: opts.thread as string } : {}),
        sessionPolicy: opts.sessionPolicy as "stateless" | "shared-session",
        ...(typeof opts.at === "string" ? { at: opts.at as string } : {}),
        ...(parsedEveryMs !== null && Number.isFinite(parsedEveryMs) ? { everyMs: parsedEveryMs } : {}),
        ...(typeof opts.cron === "string" ? { cronExpr: opts.cron as string } : {}),
        ...(typeof opts.tz === "string" ? { tz: opts.tz as string } : {}),
        ...(typeof opts.cronConfig === "string" ? { cronConfigPath: opts.cronConfig as string } : {}),
      });
    });

  cronCommand
    .command("list")
    .description("List cron jobs")
    .option("--json", "Output JSON", false)
    .option("--cron-config <path>", "Override cron config path")
    .action(async (opts) => {
      await runCronListCommand({
        json: Boolean(opts.json),
        ...(typeof opts.cronConfig === "string" ? { cronConfigPath: opts.cronConfig as string } : {}),
      });
    });

  cronCommand
    .command("status")
    .description("Show status for all jobs or one job")
    .argument("[jobId]", "Cron job ID")
    .option("--json", "Output JSON", false)
    .option("--cron-config <path>", "Override cron config path")
    .action(async (jobId: string | undefined, opts) => {
      await runCronStatusCommand({
        ...(typeof jobId === "string" ? { jobId } : {}),
        json: Boolean(opts.json),
        ...(typeof opts.cronConfig === "string" ? { cronConfigPath: opts.cronConfig as string } : {}),
      });
    });

  cronCommand
    .command("run")
    .description("Queue one cron job for immediate execution")
    .argument("<jobId>", "Cron job ID")
    .option("--cron-config <path>", "Override cron config path")
    .action(async (jobId: string, opts) => {
      await runCronRunCommand({
        jobId,
        ...(typeof opts.cronConfig === "string" ? { cronConfigPath: opts.cronConfig as string } : {}),
      });
    });

  cronCommand
    .command("update")
    .description("Update one cron job")
    .argument("<jobId>", "Cron job ID")
    .option("--name <name>", "Job name")
    .option("--prompt <text>", "Job prompt")
    .option("--connector <id>", "Connector instance ID")
    .option("--route <id>", "Route ID")
    .option("--channel <id>", "Delivery channel/chat ID")
    .option("--thread <id>", "Delivery thread ID")
    .option("--clear-thread", "Unset delivery thread", false)
    .option("--session-policy <policy>", "Session policy: stateless|shared-session")
    .option("--at <iso>", "Run once at ISO timestamp")
    .option("--every-ms <ms>", "Run at fixed interval in milliseconds")
    .option("--cron <expr>", "Cron expression")
    .option("--tz <tz>", "Timezone for cron expression")
    .option("--cron-config <path>", "Override cron config path")
    .action(async (jobId: string, opts) => {
      const parsedEveryMs = typeof opts.everyMs === "string" ? Number(opts.everyMs) : null;
      await runCronUpdateCommand({
        jobId,
        ...(typeof opts.name === "string" ? { name: opts.name as string } : {}),
        ...(typeof opts.prompt === "string" ? { prompt: opts.prompt as string } : {}),
        ...(typeof opts.connector === "string" ? { connectorId: opts.connector as string } : {}),
        ...(typeof opts.route === "string" ? { routeId: opts.route as string } : {}),
        ...(typeof opts.channel === "string" ? { channelId: opts.channel as string } : {}),
        ...(typeof opts.thread === "string" ? { threadId: opts.thread as string } : {}),
        clearThread: Boolean(opts.clearThread),
        ...(typeof opts.sessionPolicy === "string"
          ? { sessionPolicy: opts.sessionPolicy as "stateless" | "shared-session" }
          : {}),
        ...(typeof opts.at === "string" ? { at: opts.at as string } : {}),
        ...(parsedEveryMs !== null && Number.isFinite(parsedEveryMs) ? { everyMs: parsedEveryMs } : {}),
        ...(typeof opts.cron === "string" ? { cronExpr: opts.cron as string } : {}),
        ...(typeof opts.tz === "string" ? { tz: opts.tz as string } : {}),
        ...(typeof opts.cronConfig === "string" ? { cronConfigPath: opts.cronConfig as string } : {}),
      });
    });

  cronCommand
    .command("remove")
    .description("Remove one cron job")
    .argument("<jobId>", "Cron job ID")
    .option("--cron-config <path>", "Override cron config path")
    .action(async (jobId: string, opts) => {
      await runCronRemoveCommand({
        jobId,
        ...(typeof opts.cronConfig === "string" ? { cronConfigPath: opts.cronConfig as string } : {}),
      });
    });

  cronCommand
    .command("pause")
    .description("Pause one cron job")
    .argument("<jobId>", "Cron job ID")
    .option("--cron-config <path>", "Override cron config path")
    .action(async (jobId: string, opts) => {
      await runCronPauseCommand({
        jobId,
        ...(typeof opts.cronConfig === "string" ? { cronConfigPath: opts.cronConfig as string } : {}),
      });
    });

  cronCommand
    .command("resume")
    .description("Resume one cron job")
    .argument("<jobId>", "Cron job ID")
    .option("--cron-config <path>", "Override cron config path")
    .action(async (jobId: string, opts) => {
      await runCronResumeCommand({
        jobId,
        ...(typeof opts.cronConfig === "string" ? { cronConfigPath: opts.cronConfig as string } : {}),
      });
    });

  return program;
}
