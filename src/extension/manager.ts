import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { ExtensionManifest, GatewayLogger } from "../core/types.js";
import { readExtensionManifest } from "./manifest.js";

const STORE_PACKAGE_NAME = "im-agent-gateway-extension-store";

interface StorePackageJson {
  name: string;
  private: boolean;
  description?: string;
  dependencies?: Record<string, string>;
}

export interface InstalledExtensionInfo {
  packageName: string;
  version: string;
  manifest: ExtensionManifest;
}

export interface ListedExtensionInfo {
  packageName: string;
  version: string;
  manifest?: ExtensionManifest;
  error?: string;
}

function isJavaScriptEntry(entry: string): boolean {
  return entry.endsWith(".js") || entry.endsWith(".mjs") || entry.endsWith(".cjs");
}

function assertWithinRoot(pathToCheck: string, rootDir: string): void {
  const normalizedRoot = resolve(rootDir);
  const normalizedPath = resolve(pathToCheck);
  if (normalizedPath === normalizedRoot) {
    return;
  }

  const rootPrefix = normalizedRoot.endsWith("/") || normalizedRoot.endsWith("\\")
    ? normalizedRoot
    : `${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`;
  if (!normalizedPath.startsWith(rootPrefix)) {
    throw new Error(`Path '${normalizedPath}' escapes package root '${normalizedRoot}'`);
  }
}

function parsePackageNameFromSpec(packageSpec: string): string | null {
  const trimmed = packageSpec.trim();
  if (!trimmed) return null;

  const scopedMatch = /^(@[^/]+\/[^@]+)(?:@.+)?$/.exec(trimmed);
  if (scopedMatch?.[1]) {
    return scopedMatch[1];
  }

  if (
    trimmed.startsWith("file:")
    || trimmed.startsWith("git+")
    || trimmed.startsWith("http://")
    || trimmed.startsWith("https://")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../")
    || trimmed.startsWith("/")
    || trimmed.includes("/")
  ) {
    return null;
  }

  const unscopedMatch = /^([^@]+)(?:@.+)?$/.exec(trimmed);
  return unscopedMatch?.[1] ?? null;
}

function pickInstalledPackageName(
  packageSpec: string,
  beforeDeps: Record<string, string>,
  afterDeps: Record<string, string>,
): string {
  const changedPackages = Object.entries(afterDeps)
    .filter(([name, version]) => beforeDeps[name] !== version)
    .map(([name]) => name);

  if (changedPackages.length === 1) {
    return changedPackages[0]!;
  }

  const inferred = parsePackageNameFromSpec(packageSpec);
  if (inferred && afterDeps[inferred]) {
    return inferred;
  }

  if (changedPackages.length > 0) {
    return changedPackages[0]!;
  }

  throw new Error(
    `Could not determine installed package from spec '${packageSpec}'. Run 'extension list' to inspect extension store state.`,
  );
}

export class ExtensionStoreManager {
  constructor(
    private readonly logger: GatewayLogger,
    private readonly extensionsDir: string,
  ) { }

  async ensureStoreInitialized(): Promise<void> {
    await mkdir(this.extensionsDir, { recursive: true });
    const storePackageJsonPath = this.storePackageJsonPath();
    try {
      await access(storePackageJsonPath);
      return;
    } catch {
      const payload: StorePackageJson = {
        name: STORE_PACKAGE_NAME,
        private: true,
        description: "Managed extension store for im-agent-gateway",
      };
      await writeFile(storePackageJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    }
  }

  async install(packageSpec: string): Promise<InstalledExtensionInfo> {
    await this.ensureStoreInitialized();
    const beforeDeps = await this.readDependencies();

    await this.runNpm(["install", "--prefix", this.extensionsDir, "--save-exact", packageSpec]);

    const afterDeps = await this.readDependencies();
    const packageName = pickInstalledPackageName(packageSpec, beforeDeps, afterDeps);
    const version = afterDeps[packageName];
    if (!version) {
      throw new Error(`Package '${packageName}' is not present in extension store after installation`);
    }

    const installed = await this.readInstalledExtension(packageName, version);
    this.logger.info(
      {
        package: installed.packageName,
        version: installed.version,
        contributions: installed.manifest.contributions.map((item) => `${item.kind}:${item.id}`),
      },
      "Extension installed",
    );
    return installed;
  }

  async uninstall(packageName: string): Promise<void> {
    await this.ensureStoreInitialized();
    await this.runNpm(["uninstall", "--prefix", this.extensionsDir, packageName]);
    this.logger.info({ package: packageName }, "Extension uninstalled");
  }

  async listInstalled(): Promise<ListedExtensionInfo[]> {
    await this.ensureStoreInitialized();
    const dependencies = await this.readDependencies();

    const listed: ListedExtensionInfo[] = [];
    const names = Object.keys(dependencies).sort((a, b) => a.localeCompare(b));
    for (const packageName of names) {
      const version = dependencies[packageName]!;
      try {
        const installed = await this.readInstalledExtension(packageName, version);
        listed.push({
          packageName,
          version,
          manifest: installed.manifest,
        });
      } catch (error) {
        listed.push({
          packageName,
          version,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return listed;
  }

  private storePackageJsonPath(): string {
    return join(this.extensionsDir, "package.json");
  }

  private createStoreRequire(): NodeRequire {
    return createRequire(this.storePackageJsonPath());
  }

  private async readDependencies(): Promise<Record<string, string>> {
    const path = this.storePackageJsonPath();
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as StorePackageJson;
      return parsed.dependencies ?? {};
    } catch {
      return {};
    }
  }

  private async readInstalledExtension(packageName: string, version: string): Promise<InstalledExtensionInfo> {
    const storeRequire = this.createStoreRequire();

    let packageJsonPath: string;
    try {
      packageJsonPath = storeRequire.resolve(`${packageName}/package.json`);
    } catch (error) {
      throw new Error(
        `Package '${packageName}' is declared in extension store but cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const packageRoot = dirname(packageJsonPath);
    const manifestPath = resolve(packageRoot, "im-agent-gateway.manifest.json");
    const manifest = await readExtensionManifest(manifestPath);

    for (const contribution of manifest.contributions) {
      if (!isJavaScriptEntry(contribution.entry)) {
        throw new Error(
          `Contribution '${contribution.id}' in package '${packageName}' must use a built JavaScript entry, got '${contribution.entry}'`,
        );
      }

      const entryPath = resolve(packageRoot, contribution.entry);
      assertWithinRoot(entryPath, packageRoot);
      try {
        await access(entryPath);
      } catch {
        throw new Error(
          `Contribution '${contribution.id}' in package '${packageName}' points to missing entry '${contribution.entry}'`,
        );
      }
    }

    return {
      packageName,
      version,
      manifest,
    };
  }

  private async runNpm(args: string[]): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const command = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(command, args, {
        stdio: "inherit",
        env: process.env,
      });

      child.once("error", (error) => {
        rejectPromise(error);
      });

      child.once("exit", (code) => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(`npm ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
      });
    });
  }
}
