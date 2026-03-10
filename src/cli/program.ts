import { Command } from "commander";
import {
  runConfigListCommand,
  runConfigSchemaListCommand,
  runConfigSchemaShowCommand,
  runConfigShowCommand,
} from "./commands/config.js";
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

  const configCommand = program.command("config").description("Inspect config");

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
