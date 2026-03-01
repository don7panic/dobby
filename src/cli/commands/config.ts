import {
  cancel,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
} from "@clack/prompts";
import { ensureGatewayConfigShape } from "../shared/config-mutators.js";
import { requireRawConfig, resolveConfigPath, writeConfigWithValidation } from "../shared/config-io.js";
import type { RawGatewayConfig } from "../shared/config-types.js";
import {
  applyConfigureSection,
  isConfigureSection,
  normalizeConfigureSectionOrder,
  type ConfigureSection,
} from "../shared/configure-sections.js";

export const CONFIG_SECTION_VALUES = ["providers", "connectors", "routing", "sandboxes", "data", "extensions"] as const;

export type ConfigSection = (typeof CONFIG_SECTION_VALUES)[number];

interface ConfigListEntry {
  key: string;
  type: string;
  children?: number;
  preview: string;
}

const EDITABLE_CONFIG_SECTIONS: ConfigureSection[] = ["provider", "connector", "routing"];

/**
 * Validates section identifiers accepted by `config show|list`.
 */
export function isConfigSection(value: string): value is ConfigSection {
  return CONFIG_SECTION_VALUES.includes(value as ConfigSection);
}

/**
 * Returns a stable scalar/object/array type label for list output.
 */
function describeValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

/**
 * Guards plain object-like values for preview/list summary generation.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Renders a compact preview string for list rows.
 */
export function previewConfigValue(value: unknown, maxLength = 80): string {
  let raw: string;
  if (value === null) {
    raw = "null";
  } else if (typeof value === "string") {
    raw = JSON.stringify(value);
  } else if (typeof value === "number" || typeof value === "boolean") {
    raw = String(value);
  } else if (Array.isArray(value)) {
    const head = value.slice(0, 3).map((item) => previewConfigValue(item, 24)).join(", ");
    raw = `[${head}${value.length > 3 ? ", ..." : ""}]`;
  } else if (isRecord(value)) {
    const keys = Object.keys(value);
    const head = keys.slice(0, 3).join(", ");
    raw = `{${head}${keys.length > 3 ? ", ..." : ""}}`;
  } else {
    raw = String(value);
  }

  return raw.length > maxLength ? `${raw.slice(0, maxLength - 3)}...` : raw;
}

/**
 * Summarizes one object value into list-friendly rows.
 */
export function buildConfigListEntries(value: unknown): ConfigListEntry[] {
  if (!isRecord(value)) {
    return [
      {
        key: "(value)",
        type: describeValueType(value),
        preview: previewConfigValue(value),
      },
    ];
  }

  return Object.entries(value)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, item]) => ({
      key,
      type: describeValueType(item),
      ...(isRecord(item) ? { children: Object.keys(item).length } : {}),
      ...(Array.isArray(item) ? { children: item.length } : {}),
      preview: previewConfigValue(item),
    }));
}

/**
 * Picks and validates a top-level config section.
 */
function resolveConfigSection(section?: string): ConfigSection | undefined {
  if (!section) {
    return undefined;
  }

  if (!isConfigSection(section)) {
    throw new Error(`Unknown section '${section}'. Allowed: ${CONFIG_SECTION_VALUES.join(", ")}`);
  }

  return section;
}

/**
 * Pretty prints list rows for human-readable CLI output.
 */
function printListEntries(entries: ConfigListEntry[]): void {
  if (entries.length === 0) {
    console.log("(empty)");
    return;
  }

  for (const entry of entries) {
    const children = entry.children !== undefined ? `, children=${entry.children}` : "";
    console.log(`${entry.key}: type=${entry.type}${children}, preview=${entry.preview}`);
  }
}

/**
 * Loads current config and normalizes missing sections to make read output stable.
 */
async function loadNormalizedConfig(): Promise<RawGatewayConfig> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  return ensureGatewayConfigShape(structuredClone(rawConfig));
}

/**
 * Prints full config or one top-level section.
 */
export async function runConfigShowCommand(options: {
  section?: string;
  json?: boolean;
}): Promise<void> {
  const normalized = await loadNormalizedConfig();
  const section = resolveConfigSection(options.section);
  const value = section ? normalized[section] : normalized;

  if (options.json) {
    console.log(JSON.stringify(value ?? null));
    return;
  }

  console.log(JSON.stringify(value ?? null, null, 2));
}

/**
 * Prints a typed summary for top-level config sections or one section's children.
 */
export async function runConfigListCommand(options: {
  section?: string;
  json?: boolean;
}): Promise<void> {
  const normalized = await loadNormalizedConfig();
  const section = resolveConfigSection(options.section);
  const entries = section
    ? buildConfigListEntries(normalized[section])
    : CONFIG_SECTION_VALUES.map((key) => ({
      key,
      type: describeValueType(normalized[key]),
      ...(isRecord(normalized[key]) ? { children: Object.keys(normalized[key] as Record<string, unknown>).length } : {}),
      ...(Array.isArray(normalized[key]) ? { children: (normalized[key] as unknown[]).length } : {}),
      preview: previewConfigValue(normalized[key]),
    }));

  if (options.json) {
    console.log(JSON.stringify(entries));
    return;
  }

  printListEntries(entries);
}

/**
 * Resolves interactive `config edit` target sections from flags or prompt.
 */
async function resolveEditSections(sections: string[]): Promise<ConfigureSection[]> {
  if (sections.length > 0) {
    const normalized: ConfigureSection[] = [];
    for (const section of sections) {
      if (!isConfigureSection(section) || !EDITABLE_CONFIG_SECTIONS.includes(section)) {
        throw new Error(`Unknown --section '${section}'. Allowed: ${EDITABLE_CONFIG_SECTIONS.join(", ")}`);
      }
      normalized.push(section);
    }
    return normalized;
  }

  const picked = await multiselect({
    message: "Select sections to edit",
    options: EDITABLE_CONFIG_SECTIONS.map((section) => ({ value: section, label: section })),
    initialValues: ["provider", "connector", "routing"],
    required: true,
  });

  if (isCancel(picked)) {
    cancel("Config edit cancelled.");
    throw new Error("Config edit cancelled.");
  }

  return picked as ConfigureSection[];
}

/**
 * Runs interactive high-frequency config editing with one validated atomic write.
 */
export async function runConfigEditCommand(options: {
  sections: string[];
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const next = ensureGatewayConfigShape(structuredClone(rawConfig));

  intro("dobby config edit");

  const requestedSections = await resolveEditSections(options.sections);
  const sections = normalizeConfigureSectionOrder(requestedSections);
  if (sections.join(",") !== requestedSections.join(",")) {
    await note(`Execution order: ${sections.join(" -> ")}`, "Info");
  }

  for (const section of sections) {
    await applyConfigureSection(next, section);
    await note(`Section '${section}' prepared`, "Updated");
  }

  await writeConfigWithValidation(configPath, next, {
    validate: true,
    createBackup: true,
  });
  await note(`Saved to ${configPath}`, "Saved");

  outro("Configuration updated.");
}
