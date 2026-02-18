import { join } from "node:path";
import type {
  ConnectorContributionModule,
  ConnectorPlugin,
  ConnectorsConfig,
  DataConfig,
  ExtensionHostContext,
  ProviderContributionModule,
  ProvidersConfig,
  ProviderInstance,
  SandboxContributionModule,
  SandboxesConfig,
  SandboxInstance,
} from "../core/types.js";
import type { LoadedExtensionPackage } from "./loader.js";

interface ProviderContributionRegistration {
  contributionId: string;
  packageName: string;
  createInstance: (options: {
    instanceId: string;
    config: Record<string, unknown>;
    host: ExtensionHostContext;
    data: DataConfig;
  }) => Promise<ProviderInstance> | ProviderInstance;
}

interface ConnectorContributionRegistration {
  contributionId: string;
  packageName: string;
  createInstance: (options: {
    instanceId: string;
    config: Record<string, unknown>;
    host: ExtensionHostContext;
    attachmentsRoot: string;
  }) => Promise<ConnectorPlugin> | ConnectorPlugin;
}

interface SandboxContributionRegistration {
  contributionId: string;
  packageName: string;
  createInstance: (options: {
    instanceId: string;
    config: Record<string, unknown>;
    host: ExtensionHostContext;
  }) => Promise<SandboxInstance> | SandboxInstance;
}

export class ExtensionRegistry {
  private readonly providers = new Map<string, ProviderContributionRegistration>();
  private readonly connectors = new Map<string, ConnectorContributionRegistration>();
  private readonly sandboxes = new Map<string, SandboxContributionRegistration>();

  registerPackages(loadedPackages: LoadedExtensionPackage[]): void {
    for (const extensionPackage of loadedPackages) {
      for (const contribution of extensionPackage.contributions) {
        if (contribution.manifest.kind === "provider") {
          const module = contribution.module as ProviderContributionModule;
          if (this.providers.has(contribution.manifest.id)) {
            throw new Error(`Duplicate provider contribution id '${contribution.manifest.id}'`);
          }
          this.providers.set(contribution.manifest.id, {
            contributionId: contribution.manifest.id,
            packageName: extensionPackage.packageName,
            createInstance: module.createInstance,
          });
          continue;
        }

        if (contribution.manifest.kind === "connector") {
          const module = contribution.module as ConnectorContributionModule;
          if (this.connectors.has(contribution.manifest.id)) {
            throw new Error(`Duplicate connector contribution id '${contribution.manifest.id}'`);
          }
          this.connectors.set(contribution.manifest.id, {
            contributionId: contribution.manifest.id,
            packageName: extensionPackage.packageName,
            createInstance: module.createInstance,
          });
          continue;
        }

        const module = contribution.module as SandboxContributionModule;
        if (this.sandboxes.has(contribution.manifest.id)) {
          throw new Error(`Duplicate sandbox contribution id '${contribution.manifest.id}'`);
        }
        this.sandboxes.set(contribution.manifest.id, {
          contributionId: contribution.manifest.id,
          packageName: extensionPackage.packageName,
          createInstance: module.createInstance,
        });
      }
    }
  }

  async createProviderInstances(
    config: ProvidersConfig,
    context: ExtensionHostContext,
    data: DataConfig,
  ): Promise<Map<string, ProviderInstance>> {
    const instances = new Map<string, ProviderInstance>();

    for (const [instanceId, instanceConfig] of Object.entries(config.instances)) {
      const contribution = this.providers.get(instanceConfig.contributionId);
      if (!contribution) {
        throw new Error(
          `Provider instance '${instanceId}' references unknown contribution '${instanceConfig.contributionId}'`,
        );
      }
      const instance = await contribution.createInstance({
        instanceId,
        config: instanceConfig.config,
        host: context,
        data,
      });
      instances.set(instanceId, instance);
    }

    return instances;
  }

  async createConnectorInstances(
    config: ConnectorsConfig,
    context: ExtensionHostContext,
    attachmentsBaseDir: string,
  ): Promise<ConnectorPlugin[]> {
    const instances: ConnectorPlugin[] = [];

    for (const [instanceId, instanceConfig] of Object.entries(config.instances)) {
      const contribution = this.connectors.get(instanceConfig.contributionId);
      if (!contribution) {
        throw new Error(
          `Connector instance '${instanceId}' references unknown contribution '${instanceConfig.contributionId}'`,
        );
      }
      const connector = await contribution.createInstance({
        instanceId,
        config: instanceConfig.config,
        host: context,
        attachmentsRoot: join(attachmentsBaseDir, instanceId),
      });
      instances.push(connector);
    }

    return instances;
  }

  async createSandboxInstances(
    config: SandboxesConfig,
    context: ExtensionHostContext,
  ): Promise<Map<string, SandboxInstance>> {
    const instances = new Map<string, SandboxInstance>();

    for (const [instanceId, instanceConfig] of Object.entries(config.instances)) {
      const contribution = this.sandboxes.get(instanceConfig.contributionId);
      if (!contribution) {
        throw new Error(
          `Sandbox instance '${instanceId}' references unknown contribution '${instanceConfig.contributionId}'`,
        );
      }
      const sandbox = await contribution.createInstance({
        instanceId,
        config: instanceConfig.config,
        host: context,
      });
      instances.set(instanceId, sandbox);
    }

    return instances;
  }
}
