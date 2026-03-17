import assert from "node:assert/strict";
import test from "node:test";
import { CommanderError } from "commander";
import { buildProgram } from "../program.js";

test("CLI rejects --config option", async () => {
  const program = buildProgram();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  program.exitOverride();

  await assert.rejects(
    program.parseAsync(["node", "dobby", "--config", "./config/gateway.json"]),
    (error) => {
      assert.equal(error instanceof CommanderError, true);
      assert.equal((error as CommanderError).code, "commander.unknownOption");
      assert.match(String((error as CommanderError).message), /unknown option '--config'/i);
      return true;
    },
  );
});

test("init help has no merge/overwrite flags", () => {
  const program = buildProgram();
  const initCommand = program.commands.find((command) => command.name() === "init");
  assert.ok(initCommand);

  const help = initCommand.helpInformation();
  assert.equal(help.includes("--merge"), false);
  assert.equal(help.includes("--merge-strategy"), false);
  assert.equal(help.includes("--overwrite"), false);

  assert.equal(help.includes("--preset"), false);
  assert.equal(help.includes("--non-interactive"), false);
  assert.equal(help.includes("--yes"), false);
  assert.equal(help.includes("--config"), false);
});

test("config help shows read-only inspect commands and schema", () => {
  const program = buildProgram();
  const configCommand = program.commands.find((command) => command.name() === "config");
  assert.ok(configCommand);

  const help = configCommand.helpInformation();
  assert.match(help, /show \[options\] \[section\]/);
  assert.match(help, /list \[options\] \[section\]/);
  assert.match(help, /schema/);
  assert.equal(help.includes("edit"), false);

  assert.equal(help.includes("get"), false);
  assert.equal(help.includes("set"), false);
  assert.equal(help.includes("unset"), false);
});

test("config schema help shows list/show subcommands", () => {
  const program = buildProgram();
  const configCommand = program.commands.find((command) => command.name() === "config");
  assert.ok(configCommand);

  const schemaCommand = configCommand.commands.find((command) => command.name() === "schema");
  assert.ok(schemaCommand);

  const help = schemaCommand.helpInformation();
  assert.match(help, /list \[options\]/);
  assert.match(help, /show \[options\] <contributionId>/);
});

test("cron help shows core subcommands", () => {
  const program = buildProgram();
  const cronCommand = program.commands.find((command) => command.name() === "cron");
  assert.ok(cronCommand);

  const help = cronCommand.helpInformation();
  assert.match(help, /add \[options\] <name>/);
  assert.match(help, /list \[options\]/);
  assert.match(help, /run \[options\] <jobId>/);
  assert.match(help, /remove \[options\] <jobId>/);

  const addCommand = cronCommand.commands.find((command) => command.name() === "add");
  const updateCommand = cronCommand.commands.find((command) => command.name() === "update");
  assert.ok(addCommand);
  assert.ok(updateCommand);
  assert.equal(addCommand.helpInformation().includes("session-policy"), false);
  assert.equal(updateCommand.helpInformation().includes("session-policy"), false);
});

test("top-level help keeps bootstrap, inspect, install, validate, and ops commands only", () => {
  const program = buildProgram();
  const help = program.helpInformation();
  assert.match(help, /start/);
  assert.match(help, /init/);
  assert.match(help, /config/);
  assert.match(help, /connector/);
  assert.match(help, /extension/);
  assert.match(help, /doctor/);
  assert.match(help, /cron/);
  assert.equal(help.includes("configure"), false);
  assert.equal(help.includes("bot"), false);
  assert.equal(help.includes("binding"), false);
  assert.equal(help.includes("route"), false);
});

test("connector help shows status subcommand", () => {
  const program = buildProgram();
  const connectorCommand = program.commands.find((command) => command.name() === "connector");
  assert.ok(connectorCommand);

  const help = connectorCommand.helpInformation();
  assert.match(help, /status \[options\] \[connectorId\]/);
});
