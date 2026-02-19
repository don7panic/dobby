import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type {
  ExtensionContributionManifest,
  ExtensionContributionModule,
  ExtensionManifest,
  ExtensionPackageConfig,
  GatewayLogger,
} from "../core/types.js";

const require = createRequire(import.meta.url);

const contributionManifestSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["provider", "connector", "sandbox"]),
  entry: z.string().min(1),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

const manifestSchema = z.object({
  apiVersion: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  contributions: z.array(contributionManifestSchema).min(1),
});

export interface LoadedExtensionContribution {
  manifest: ExtensionContributionManifest;
  module: ExtensionContributionModule;
}

export interface LoadedExtensionPackage {
  packageName: string;
  manifest: ExtensionManifest;
  contributions: LoadedExtensionContribution[];
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
  constructor(private readonly logger: GatewayLogger) {}

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
      packageJsonPath = require.resolve(`${packageName}/package.json`);
    } catch (error) {
      throw new Error(`Failed to resolve extension package '${packageName}': ${error instanceof Error ? error.message : String(error)}`);
    }

    const packageRoot = dirname(packageJsonPath);
    const manifestPath = resolve(join(packageRoot, "im-agent-gateway.manifest.json"));

    const manifestRaw = await readFile(manifestPath, "utf-8");
    const manifest = manifestSchema.parse(JSON.parse(manifestRaw)) as ExtensionManifest;

    const contributions: LoadedExtensionContribution[] = [];
    for (const contributionManifest of manifest.contributions) {
      const entryPath = resolve(packageRoot, contributionManifest.entry);
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
