#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeCommand = process.execPath;

const pluginsRootDir = resolve(projectRoot, "plugins");
const pluginSdkDir = "plugins/plugin-sdk";

async function discoverLocalExtensionPackages() {
  const entries = await readdir(pluginsRootDir, { withFileTypes: true });
  const discovered = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === "plugin-sdk") {
      continue;
    }

    const relativeDir = `plugins/${entry.name}`;
    const packageJsonPath = resolve(projectRoot, relativeDir, "package.json");
    const manifestPath = resolve(projectRoot, relativeDir, "dobby.manifest.json");

    try {
      await access(packageJsonPath);
      await access(manifestPath);
      const rawPackageJson = await readFile(packageJsonPath, "utf-8");
      const parsedPackageJson = JSON.parse(rawPackageJson);
      if (typeof parsedPackageJson?.name !== "string" || parsedPackageJson.name.length === 0) {
        throw new Error(`Missing package name in ${packageJsonPath}`);
      }

      discovered.push({
        name: parsedPackageJson.name,
        dir: relativeDir,
      });
    } catch {
      continue;
    }
  }

  discovered.sort((a, b) => a.dir.localeCompare(b.dir));
  return discovered;
}

function printUsage() {
  console.log("Usage: node scripts/local-extensions.mjs <command> [--config <path>]");
  console.log("");
  console.log("Commands:");
  console.log("  install       Install local plugin development dependencies");
  console.log("  check         Type-check local extension plugins");
  console.log("  build         Build local extension plugins");
  console.log("  install-store Install local extension plugins into extension store");
  console.log("  list-store    List installed extensions from extension store");
  console.log("  setup         Run install + build + install-store");
}

function parseConfigPath(args) {
  const flagIndex = args.findIndex((arg) => arg === "--config");
  if (flagIndex === -1) {
    return resolve(projectRoot, "config", "gateway.json");
  }

  const value = args[flagIndex + 1];
  if (!value) {
    throw new Error("Missing value for --config");
  }

  return resolve(projectRoot, value);
}

async function run(command, args) {
  const pretty = [command, ...args].join(" ");
  console.log(`$ ${pretty}`);

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", (error) => rejectPromise(error));
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Command failed (${code ?? "unknown"}): ${pretty}`));
    });
  });
}

async function installLocalPluginDeps(localExtensionPackages) {
  await run(npmCommand, ["install", "--prefix", pluginSdkDir]);
  for (const item of localExtensionPackages) {
    await run(npmCommand, ["install", "--prefix", item.dir]);
  }
}

async function checkLocalPlugins(localExtensionPackages) {
  for (const item of localExtensionPackages) {
    await run(npmCommand, ["run", "check", "--prefix", item.dir]);
  }
}

async function buildLocalPlugins(localExtensionPackages) {
  for (const item of localExtensionPackages) {
    await run(npmCommand, ["run", "build", "--prefix", item.dir]);
  }
}

async function installToExtensionStore(localExtensionPackages, configPath) {
  for (const item of localExtensionPackages) {
    await run(nodeCommand, [
      "--import",
      "tsx",
      "src/main.ts",
      "extension",
      "install",
      `file:./${item.dir}`,
      "--config",
      configPath,
    ]);
  }
}

async function listExtensionStore(configPath) {
  await run(nodeCommand, ["--import", "tsx", "src/main.ts", "extension", "list", "--config", configPath]);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  const configPath = parseConfigPath(rest);
  const needsLocalPackages = command !== "list-store";
  const localExtensionPackages = needsLocalPackages ? await discoverLocalExtensionPackages() : [];
  if (needsLocalPackages && localExtensionPackages.length === 0) {
    throw new Error("No local extension packages found under ./plugins");
  }

  switch (command) {
    case "install":
      await installLocalPluginDeps(localExtensionPackages);
      return;
    case "check":
      await checkLocalPlugins(localExtensionPackages);
      return;
    case "build":
      await buildLocalPlugins(localExtensionPackages);
      return;
    case "install-store":
      await installToExtensionStore(localExtensionPackages, configPath);
      return;
    case "list-store":
      await listExtensionStore(configPath);
      return;
    case "setup":
      await installLocalPluginDeps(localExtensionPackages);
      await buildLocalPlugins(localExtensionPackages);
      await installToExtensionStore(localExtensionPackages, configPath);
      return;
    default:
      throw new Error(`Unknown command '${command}'`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
