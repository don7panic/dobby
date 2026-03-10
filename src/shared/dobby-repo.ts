import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DOBBY_REPO_PACKAGE_NAMES = new Set(["dobby", "@dobby.ai/dobby"]);

function readPackageName(candidateDir: string): string | undefined {
  const packageJsonPath = resolve(candidateDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const packageJsonRaw = readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(packageJsonRaw) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

export function isDobbyRepoRoot(candidateDir: string): boolean {
  const repoConfigPath = resolve(candidateDir, "config", "gateway.json");
  const repoConfigExamplePath = resolve(candidateDir, "config", "gateway.example.json");
  const localExtensionsScriptPath = resolve(candidateDir, "scripts", "local-extensions.mjs");

  if ((!existsSync(repoConfigPath) && !existsSync(repoConfigExamplePath)) || !existsSync(localExtensionsScriptPath)) {
    return false;
  }

  const packageName = readPackageName(candidateDir);
  return packageName !== undefined && DOBBY_REPO_PACKAGE_NAMES.has(packageName);
}

export function findDobbyRepoRoot(startDir: string): string | null {
  let currentDir = resolve(startDir);

  while (true) {
    if (isDobbyRepoRoot(currentDir)) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}
