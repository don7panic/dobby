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

test("init help shows only merge-related flags", () => {
  const program = buildProgram();
  const initCommand = program.commands.find((command) => command.name() === "init");
  assert.ok(initCommand);

  const help = initCommand.helpInformation();
  assert.match(help, /--merge/);
  assert.match(help, /--merge-strategy/);
  assert.match(help, /--overwrite/);

  assert.equal(help.includes("--preset"), false);
  assert.equal(help.includes("--non-interactive"), false);
  assert.equal(help.includes("--yes"), false);
  assert.equal(help.includes("--config"), false);
});

test("config help shows show/list/edit only", () => {
  const program = buildProgram();
  const configCommand = program.commands.find((command) => command.name() === "config");
  assert.ok(configCommand);

  const help = configCommand.helpInformation();
  assert.match(help, /show \[options\] \[section\]/);
  assert.match(help, /list \[options\] \[section\]/);
  assert.match(help, /edit \[options\]/);

  assert.equal(help.includes("get"), false);
  assert.equal(help.includes("set"), false);
  assert.equal(help.includes("unset"), false);
});
