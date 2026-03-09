import assert from "node:assert/strict";
import test from "node:test";
import { parseControlCommand } from "../control-command.js";

test("parseControlCommand recognizes cancel aliases", () => {
  assert.equal(parseControlCommand("stop"), "cancel");
  assert.equal(parseControlCommand(" /STOP "), "cancel");
  assert.equal(parseControlCommand("/cancel"), "cancel");
});

test("parseControlCommand recognizes new session aliases", () => {
  assert.equal(parseControlCommand("/new"), "new_session");
  assert.equal(parseControlCommand(" /reset "), "new_session");
});

test("parseControlCommand ignores regular messages", () => {
  assert.equal(parseControlCommand("please /new"), null);
  assert.equal(parseControlCommand(""), null);
  assert.equal(parseControlCommand("hello"), null);
});
