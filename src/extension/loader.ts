import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type {
  ExtensionContributionManifest,
  ExtensionContributionModule,
  ExtensionManifest,
  ExtensionPackageConfig,
  GatewayLogger,
} from "../core/types.js";
import { readExtensionManifest } from "./manifest.js";

export interface LoadedExtensionContribution {
  manifest: ExtensionContributionManifest;
  module: ExtensionContributionModule;
}

export interface LoadedExtensionPackage {
  packageName: string;
  manifest: ExtensionManifest;
  contributions: LoadedExtensionContribution[];
}

interface ExtensionLoaderOptions {
  extensionsDir: string;
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

function pickContributionModule(loadedModule: Record<string, unknown>): unknown {
  if ("default" in loadedModule) {
    return loadedModule.default;
  }
  if ("contribution" in loadedModule) {
    return loadedModule.contribution;
  }
  return undefined;
}

export class ExtensionLoader {
  private readonly extensionRequire: NodeJS.Require;

  constructor(
    private readonly logger: GatewayLogger,
    private readonly options: ExtensionLoaderOptions,
  ) {
    this.extensionRequire = createRequire(join(this.options.extensionsDir, "package.json"));
  }

  async loadAllowList(allowList: ExtensionPackageConfig[]): Promise<LoadedExtensionPackage[]> {
    const loaded: LoadedExtensionPackage[] = [];

    for (const packageConfig of allowList) {
      if (packageConfig.enabled === false) {
        this.logger.info({ package: packageConfig.package }, "Skipping disabled extension package");
        continue;
      }

      loaded.push(await this.loadExternalPackage(packageConfig.package));
    }

    return loaded;
  }

  private async loadExternalPackage(packageName: string): Promise<LoadedExtensionPackage> {
    let packageJsonPath: string;
    try {
      packageJsonPath = this.extensionRequire.resolve(`${packageName}/package.json`);
    } catch (error) {
      throw new Error(
        `Extension package '${packageName}' is not installed in '${this.options.extensionsDir}'. ` +
        `Install it with: dobby extension install ${packageName}. ` +
        `Resolver error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const packageRoot = dirname(packageJsonPath);
    const manifestPath = resolve(join(packageRoot, "dobby.manifest.json"));
    const manifest = await readExtensionManifest(manifestPath);

    const contributions: LoadedExtensionContribution[] = [];
    for (const contributionManifest of manifest.contributions) {
      if (!isJavaScriptEntry(contributionManifest.entry)) {
        throw new Error(
          `Contribution '${contributionManifest.id}' in package '${packageName}' must use a built JavaScript entry, got '${contributionManifest.entry}'`,
        );
      }

      const entryPath = resolve(packageRoot, contributionManifest.entry);
      assertWithinRoot(entryPath, packageRoot);
      try {
        await access(entryPath);
      } catch {
        throw new Error(
          `Contribution '${contributionManifest.id}' in package '${packageName}' points to missing entry '${contributionManifest.entry}'`,
        );
      }

      const loadedModule = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
      const contributionModule = pickContributionModule(loadedModule);

      if (!contributionModule || typeof contributionModule !== "object") {
        throw new Error(
          `Extension contribution '${contributionManifest.id}' from package '${packageName}' does not export a valid module`,
        );
      }

      const kind = (contributionModule as { kind?: string }).kind;
      if (kind !== contributionManifest.kind) {
        throw new Error(
          `Contribution kind mismatch for '${contributionManifest.id}' in package '${packageName}': manifest=${contributionManifest.kind}, module=${kind ?? "unknown"}`,
        );
      }

      contributions.push({
        manifest: contributionManifest,
        module: contributionModule as ExtensionContributionModule,
      });
    }

    return {
      packageName,
      manifest,
      contributions,
    };
  }
}
