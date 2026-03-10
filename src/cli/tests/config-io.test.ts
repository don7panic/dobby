import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG_PATH, resolveConfigPath, resolveDataRootDir } from "../shared/config-io.js";

test("resolveConfigPath defaults to $HOME/.dobby/gateway.json", () => {
  assert.equal(DEFAULT_CONFIG_PATH, resolve(homedir(), ".dobby", "gateway.json"));
});

test("resolveConfigPath falls back to default path outside dobby repository", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "dobby-config-path-default-"));
  assert.equal(resolveConfigPath({ cwd, env: {} }), DEFAULT_CONFIG_PATH);
});

test("resolveConfigPath detects local dobby repository config path", async () => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), "dobby-config-path-repo-"));
  await mkdir(resolve(repoRoot, "config"), { recursive: true });
  await mkdir(resolve(repoRoot, "scripts"), { recursive: true });
  await mkdir(resolve(repoRoot, "src", "cli"), { recursive: true });

  await writeFile(resolve(repoRoot, "package.json"), JSON.stringify({ name: "@dobby.ai/dobby" }), "utf-8");
  await writeFile(resolve(repoRoot, "config", "gateway.example.json"), "{}\n", "utf-8");
  await writeFile(resolve(repoRoot, "scripts", "local-extensions.mjs"), "#!/usr/bin/env node\n", "utf-8");

  assert.equal(
    resolveConfigPath({
      cwd: resolve(repoRoot, "src", "cli"),
      env: {},
    }),
    resolve(repoRoot, "config", "gateway.json"),
  );
});

test("resolveConfigPath prioritizes DOBBY_CONFIG_PATH over repository detection", async () => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), "dobby-config-path-env-priority-"));
  await mkdir(resolve(repoRoot, "config"), { recursive: true });
  await mkdir(resolve(repoRoot, "scripts"), { recursive: true });
  await writeFile(resolve(repoRoot, "package.json"), JSON.stringify({ name: "@dobby.ai/dobby" }), "utf-8");
  await writeFile(resolve(repoRoot, "config", "gateway.example.json"), "{}\n", "utf-8");
  await writeFile(resolve(repoRoot, "scripts", "local-extensions.mjs"), "#!/usr/bin/env node\n", "utf-8");

  const customPath = resolve(tmpdir(), "dobby-custom-gateway.json");
  assert.equal(
    resolveConfigPath({
      cwd: repoRoot,
      env: { DOBBY_CONFIG_PATH: customPath },
    }),
    customPath,
  );
});

test("resolveConfigPath supports relative and home-prefixed DOBBY_CONFIG_PATH", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "dobby-config-path-env-expand-"));

  assert.equal(
    resolveConfigPath({
      cwd,
      env: { DOBBY_CONFIG_PATH: "config/local-gateway.json" },
    }),
    resolve(cwd, "config/local-gateway.json"),
  );

  assert.equal(
    resolveConfigPath({
      cwd,
      env: { DOBBY_CONFIG_PATH: "~/custom-gateway.json" },
    }),
    resolve(homedir(), "custom-gateway.json"),
  );
});

test("resolveDataRootDir uses repo root for repo-local config/gateway.json", async () => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), "dobby-data-root-repo-"));
  await mkdir(resolve(repoRoot, "config"), { recursive: true });
  await mkdir(resolve(repoRoot, "scripts"), { recursive: true });

  await writeFile(resolve(repoRoot, "package.json"), JSON.stringify({ name: "@dobby.ai/dobby" }), "utf-8");
  await writeFile(resolve(repoRoot, "config", "gateway.json"), "{}", "utf-8");
  await writeFile(resolve(repoRoot, "scripts", "local-extensions.mjs"), "#!/usr/bin/env node\n", "utf-8");

  assert.equal(
    resolveDataRootDir(resolve(repoRoot, "config", "gateway.json"), {
      data: {
        rootDir: "./data",
      },
    }),
    resolve(repoRoot, "data"),
  );
});
