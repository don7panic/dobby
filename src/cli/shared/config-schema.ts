import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { join } from "node:path";
import pino from "pino";
import type { ExtensionKind } from "../../core/types.js";
import { ExtensionLoader } from "../../extension/loader.js";
import { ExtensionRegistry } from "../../extension/registry.js";
import { ensureGatewayConfigShape } from "./config-mutators.js";
import { resolveDataRootDir } from "./config-io.js";
import type { RawExtensionInstanceConfig, RawGatewayConfig } from "./config-types.js";

export interface ContributionSchemaCatalogEntry {
  contributionId: string;
  packageName: string;
  kind: ExtensionKind;
  configSchema?: Record<string, unknown>;
}

export interface ContributionSchemaListItem {
  contributionId: string;
  packageName: string;
  kind: ExtensionKind;
  hasSchema: boolean;
}

interface InstanceValidationTask {
  section: "providers" | "connectors" | "sandboxes";
  instanceId: string;
  instance: RawExtensionInstanceConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeJsonPointerSegment(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function normalizeSchemaForValidation(schema: Record<string, unknown>): Record<string, unknown> {
  const cloned = structuredClone(schema);
  if (isRecord(cloned) && typeof cloned.$schema === "string") {
    delete cloned.$schema;
  }
  return cloned;
}

function formatErrorPath(instancePath: string): string {
  if (!instancePath) {
    return "";
  }

  const segments = instancePath
    .split("/")
    .slice(1)
    .map((segment) => decodeJsonPointerSegment(segment))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return "";
  }

  let formatted = "";
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      formatted += `[${segment}]`;
      continue;
    }

    if (/^[a-zA-Z_$][\w$]*$/.test(segment)) {
      formatted += `.${segment}`;
      continue;
    }

    formatted += `['${segment.replaceAll("'", "\\'")}']`;
  }

  return formatted;
}

function buildValidationErrorMessage(
  task: InstanceValidationTask,
  contributionId: string,
  errors: ErrorObject[] | null | undefined,
): string {
  const details = (errors ?? [])
    .slice(0, 5)
    .map((error) => {
      const suffix = formatErrorPath(error.instancePath);
      return `${task.section}.instances['${task.instanceId}'].config${suffix}: ${error.message ?? "invalid"}`;
    })
    .join("; ");

  return (
    `Invalid config for instance '${task.instanceId}' (contribution '${contributionId}'). `
    + (details.length > 0 ? details : "Schema validation failed.")
  );
}

async function loadRegistryForConfig(
  configPath: string,
  rawConfig: RawGatewayConfig,
): Promise<ExtensionRegistry> {
  const normalized = ensureGatewayConfigShape(structuredClone(rawConfig));
  const rootDir = resolveDataRootDir(configPath, normalized);
  const loader = new ExtensionLoader(pino({ name: "dobby.config-schema", level: "silent" }), {
    extensionsDir: join(rootDir, "extensions"),
  });
  const loadedPackages = await loader.loadAllowList(normalized.extensions.allowList);
  const registry = new ExtensionRegistry();
  registry.registerPackages(loadedPackages);
  return registry;
}

/**
 * Loads contribution-level JSON Schema catalog from installed/allow-listed extensions.
 */
export async function loadContributionSchemaCatalog(
  configPath: string,
  rawConfig: RawGatewayConfig,
): Promise<ContributionSchemaCatalogEntry[]> {
  const registry = await loadRegistryForConfig(configPath, rawConfig);
  return registry.listContributionSchemas();
}

/**
 * Lists available contribution schemas with lightweight flags for CLI display.
 */
export async function listContributionSchemas(
  configPath: string,
  rawConfig: RawGatewayConfig,
): Promise<ContributionSchemaListItem[]> {
  const catalog = await loadContributionSchemaCatalog(configPath, rawConfig);
  return catalog.map((item) => ({
    contributionId: item.contributionId,
    packageName: item.packageName,
    kind: item.kind,
    hasSchema: Boolean(item.configSchema),
  }));
}

/**
 * Returns one contribution schema entry, or null when not found.
 */
export async function getContributionSchema(
  configPath: string,
  rawConfig: RawGatewayConfig,
  contributionId: string,
): Promise<ContributionSchemaCatalogEntry | null> {
  const catalog = await loadContributionSchemaCatalog(configPath, rawConfig);
  return catalog.find((item) => item.contributionId === contributionId) ?? null;
}

/**
 * Applies extension config defaults and validates provider/connector/sandbox instance configs with Ajv.
 */
export async function applyAndValidateContributionSchemas(
  configPath: string,
  rawConfig: RawGatewayConfig,
): Promise<RawGatewayConfig> {
  const next = ensureGatewayConfigShape(structuredClone(rawConfig));
  const catalog = await loadContributionSchemaCatalog(configPath, next);

  const schemaByContribution = new Map<string, Record<string, unknown>>();
  for (const entry of catalog) {
    if (!entry.configSchema) {
      continue;
    }
    schemaByContribution.set(entry.contributionId, normalizeSchemaForValidation(entry.configSchema));
  }

  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    useDefaults: true,
  });
  const validators = new Map<string, ValidateFunction>();

  const tasks: InstanceValidationTask[] = [
    ...Object.entries(next.providers.instances).map(([instanceId, instance]) => ({
      section: "providers" as const,
      instanceId,
      instance,
    })),
    ...Object.entries(next.connectors.instances).map(([instanceId, instance]) => ({
      section: "connectors" as const,
      instanceId,
      instance,
    })),
    ...Object.entries(next.sandboxes.instances).map(([instanceId, instance]) => ({
      section: "sandboxes" as const,
      instanceId,
      instance,
    })),
  ];

  for (const task of tasks) {
    const contributionId = task.instance.contributionId;
    const schema = schemaByContribution.get(contributionId);
    if (!schema) {
      continue;
    }

    let validate = validators.get(contributionId);
    if (!validate) {
      const compiled = ajv.compile(schema) as ValidateFunction;
      validators.set(contributionId, compiled);
      validate = compiled;
    }

    const instanceConfig = isRecord(task.instance.config) ? task.instance.config : {};
    task.instance.config = instanceConfig;
    const valid = validate(instanceConfig);
    if (!valid) {
      throw new Error(buildValidationErrorMessage(task, contributionId, validate.errors));
    }
  }

  return next;
}
