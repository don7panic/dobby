#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const gitCommand = process.platform === "win32" ? "git.exe" : "git";

const publishTargets = [
  { dir: "plugins/plugin-sdk" },
  { dir: "plugins/connector-discord" },
  { dir: "plugins/connector-feishu" },
  { dir: "plugins/provider-pi" },
  { dir: "plugins/provider-claude-cli" },
  { dir: "plugins/provider-claude" },
  { dir: "." },
];

function printUsage() {
  console.log("Usage: node scripts/publish-packages.mjs [--dry-run] [--tag <tag>] [--otp <code>] [--allow-dirty]");
  console.log("");
  console.log("Publishes plugin-sdk, connector/provider packages, then the root @dobby.ai/dobby package.");
  console.log("");
  console.log("Options:");
  console.log("  --dry-run      Run npm publish --dry-run for every package");
  console.log("  --tag <tag>    Publish with a custom npm dist-tag");
  console.log("  --otp <code>   Forward an npm 2FA one-time password");
  console.log("  --allow-dirty  Skip the git working tree cleanliness check");
}

async function run(command, args, cwd = projectRoot, capture = false) {
  const pretty = [command, ...args].join(" ");
  console.log(`$ ${pretty}`);

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env: process.env,
    });

    let stdout = "";
    if (capture && child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }

    child.once("error", (error) => rejectPromise(error));
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      rejectPromise(new Error(`Command failed (${code ?? "unknown"}): ${pretty}`));
    });
  });
}

async function readPackageMeta(relativeDir) {
  const packageJsonPath = resolve(projectRoot, relativeDir, "package.json");
  const raw = await readFile(packageJsonPath, "utf-8");
  const parsed = JSON.parse(raw);
  return {
    dir: relativeDir,
    name: parsed.name,
    version: parsed.version,
  };
}

async function ensureCleanWorktree() {
  const status = await run(gitCommand, ["status", "--porcelain"], projectRoot, true);
  if (status.trim().length > 0) {
    throw new Error("Working tree is not clean. Commit or stash changes first, or rerun with --allow-dirty.");
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    dryRun: false,
    allowDirty: false,
    tag: undefined,
    otp: undefined,
  };

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--allow-dirty":
        options.allowDirty = true;
        break;
      case "--tag": {
        const value = args.shift();
        if (!value) {
          throw new Error("--tag requires a value");
        }
        options.tag = value;
        break;
      }
      case "--otp": {
        const value = args.shift();
        if (!value) {
          throw new Error("--otp requires a value");
        }
        options.otp = value;
        break;
      }
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument '${token}'`);
    }
  }

  return options;
}

async function publishAll(options) {
  if (!options.allowDirty) {
    await ensureCleanWorktree();
  }

  for (const target of publishTargets) {
    const meta = await readPackageMeta(target.dir);
    const packageDir = resolve(projectRoot, target.dir);
    const publishArgs = ["publish"];

    if (options.dryRun) {
      publishArgs.push("--dry-run");
    }
    if (options.tag) {
      publishArgs.push("--tag", options.tag);
    }
    if (options.otp) {
      publishArgs.push("--otp", options.otp);
    }

    console.log(`\nPublishing ${meta.name}@${meta.version} from ${target.dir}`);
    await run(npmCommand, publishArgs, packageDir);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await publishAll(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
