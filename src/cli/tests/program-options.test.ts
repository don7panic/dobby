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

test("config help shows show/list/edit and schema", () => {
  const program = buildProgram();
  const configCommand = program.commands.find((command) => command.name() === "config");
  assert.ok(configCommand);

  const help = configCommand.helpInformation();
  assert.match(help, /show \[options\] \[section\]/);
  assert.match(help, /list \[options\] \[section\]/);
  assert.match(help, /edit \[options\]/);
  assert.match(help, /schema/);

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
});

test("binding help shows list, set, and remove subcommands", () => {
  const program = buildProgram();
  const bindingCommand = program.commands.find((command) => command.name() === "binding");
  assert.ok(bindingCommand);

  const help = bindingCommand.helpInformation();
  assert.match(help, /list \[options\]/);
  assert.match(help, /set \[options\] <bindingId>/);
  assert.match(help, /remove <bindingId>/);
});

test("route help reflects provider, sandbox, mentions, and cascade-bindings options", () => {
  const program = buildProgram();
  const routeCommand = program.commands.find((command) => command.name() === "route");
  assert.ok(routeCommand);

  const setCommand = routeCommand.commands.find((command) => command.name() === "set");
  const removeCommand = routeCommand.commands.find((command) => command.name() === "remove");
  assert.ok(setCommand);
  assert.ok(removeCommand);

  const setHelp = setCommand.helpInformation();
  const removeHelp = removeCommand.helpInformation();
  assert.match(setHelp, /--provider <id>/);
  assert.match(setHelp, /--sandbox <id>/);
  assert.match(setHelp, /--mentions <policy>/);
  assert.equal(setHelp.includes("--provider-id"), false);
  assert.equal(setHelp.includes("--sandbox-id"), false);
  assert.equal(setHelp.includes("--mentions-only"), false);
  assert.equal(setHelp.includes("--default"), false);
  assert.match(removeHelp, /--cascade-bindings/);
});
