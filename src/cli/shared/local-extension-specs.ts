import { access, readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { findDobbyRepoRoot } from "../../shared/dobby-repo.js";

interface LocalExtensionPackage {
  packageName: string;
  packageDir: string;
}

function isExplicitInstallSpec(value: string): boolean {
  return value.startsWith("file:")
    || value.startsWith("git+")
    || value.startsWith("http://")
    || value.startsWith("https://")
    || value.startsWith("./")
    || value.startsWith("../")
    || value.startsWith("/");
}

async function listRepoLocalExtensionPackages(repoRoot: string): Promise<Map<string, LocalExtensionPackage>> {
  const pluginsRoot = resolve(repoRoot, "plugins");
  const entries = await readdir(pluginsRoot, { withFileTypes: true });
  const packages = new Map<string, LocalExtensionPackage>();

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "plugin-sdk") {
      continue;
    }

    const packageDir = resolve(pluginsRoot, entry.name);
    const packageJsonPath = resolve(packageDir, "package.json");
    const manifestPath = resolve(packageDir, "dobby.manifest.json");

    try {
      await access(packageJsonPath);
      await access(manifestPath);
      const raw = await readFile(packageJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as { name?: unknown };
      if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
        continue;
      }

      packages.set(parsed.name, {
        packageName: parsed.name,
        packageDir,
      });
    } catch {
      continue;
    }
  }

  return packages;
}

async function assertLocalExtensionBuildReady(localPackage: LocalExtensionPackage): Promise<void> {
  const manifestPath = resolve(localPackage.packageDir, "dobby.manifest.json");
  const rawManifest = await readFile(manifestPath, "utf-8");
  const parsed = JSON.parse(rawManifest) as {
    contributions?: Array<{ id?: unknown; entry?: unknown }>;
  };

  for (const contribution of parsed.contributions ?? []) {
    if (typeof contribution.entry !== "string" || contribution.entry.trim().length === 0) {
      continue;
    }

    const entryPath = resolve(localPackage.packageDir, contribution.entry);
    try {
      await access(entryPath);
    } catch {
      const contributionId = typeof contribution.id === "string" ? contribution.id : "unknown";
      throw new Error(
        `Local extension '${localPackage.packageName}' is not built for contribution '${contributionId}'. `
        + `Missing '${entryPath}'. Run 'npm run build --prefix ${localPackage.packageDir}' first.`,
      );
    }
  }
}

export async function resolveExtensionInstallSpecs(packageSpecs: string[], cwd = process.cwd()): Promise<string[]> {
  const repoRoot = findDobbyRepoRoot(cwd);
  if (!repoRoot) {
    return packageSpecs;
  }

  const repoPackages = await listRepoLocalExtensionPackages(repoRoot);
  const resolvedSpecs: string[] = [];

  for (const rawSpec of packageSpecs) {
    const packageSpec = rawSpec.trim();
    if (packageSpec.length === 0 || isExplicitInstallSpec(packageSpec)) {
      resolvedSpecs.push(packageSpec);
      continue;
    }

    const localPackage = repoPackages.get(packageSpec);
    if (!localPackage) {
      resolvedSpecs.push(packageSpec);
      continue;
    }

    await assertLocalExtensionBuildReady(localPackage);
    resolvedSpecs.push(`file:${localPackage.packageDir}`);
  }

  return resolvedSpecs;
}
