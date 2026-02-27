import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG_PATH, resolveConfigPath } from "../shared/config-io.js";

test("resolveConfigPath defaults to $HOME/.dobby/gateway.json", () => {
  assert.equal(DEFAULT_CONFIG_PATH, resolve(homedir(), ".dobby", "gateway.json"));
  assert.equal(resolveConfigPath(), DEFAULT_CONFIG_PATH);
});

test("resolveConfigPath resolves explicit path inputs", () => {
  assert.equal(resolveConfigPath("./foo/bar.json"), resolve("./foo/bar.json"));
});
