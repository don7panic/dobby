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
import {
  applyConfigureSection,
  CONFIGURE_SECTION_VALUES,
  isConfigureSection,
  normalizeConfigureSectionOrder,
  type ConfigureSection,
} from "../shared/configure-sections.js";
import { applyAndValidateContributionSchemas, loadContributionSchemaCatalog } from "../shared/config-schema.js";

/**
 * Resolves target sections from CLI flags or interactive section picker.
 */
async function resolveSections(sections: string[]): Promise<ConfigureSection[]> {
  if (sections.length > 0) {
    const normalized: ConfigureSection[] = [];
    for (const section of sections) {
      if (!isConfigureSection(section)) {
        throw new Error(`Unknown --section '${section}'. Allowed: ${CONFIGURE_SECTION_VALUES.join(", ")}`);
      }
      normalized.push(section);
    }
    return normalized;
  }

  const picked = await multiselect({
    message: "Select sections to configure",
    options: CONFIGURE_SECTION_VALUES.map((section) => ({ value: section, label: section })),
    initialValues: ["provider", "connector", "route", "binding"],
    required: true,
  });

  if (isCancel(picked)) {
    cancel("Configure cancelled.");
    throw new Error("Configure cancelled.");
  }

  return picked as ConfigureSection[];
}

/**
 * Executes interactive config updates and validates one final atomic save.
 */
export async function runConfigureCommand(options: {
  sections: string[];
}): Promise<void> {
  const configPath = resolveConfigPath();
  const rawConfig = await requireRawConfig(configPath);
  const next = ensureGatewayConfigShape(structuredClone(rawConfig));

  intro("dobby configure");
  const requestedSections = await resolveSections(options.sections);
  const sections = normalizeConfigureSectionOrder(requestedSections);

  if (sections.join(",") !== requestedSections.join(",")) {
    await note(`Execution order: ${sections.join(" -> ")}`, "Info");
  }

  const catalog = await loadContributionSchemaCatalog(configPath, next);
  const schemaByContributionId = new Map(
    catalog
      .filter((item) => item.configSchema)
      .map((item) => [item.contributionId, item.configSchema!] as const),
  );
  const schemaStateByContributionId = new Map(
    catalog.map((item) => [item.contributionId, item.configSchema ? "with_schema" : "without_schema"] as const),
  );

  for (const section of sections) {
    await applyConfigureSection(section, next, { schemaByContributionId, schemaStateByContributionId });
    await note(`Section '${section}' prepared`, "Updated");
  }

  const validatedConfig = await applyAndValidateContributionSchemas(configPath, next);

  await writeConfigWithValidation(configPath, validatedConfig, {
    validate: true,
    createBackup: true,
  });
  await note(`Saved to ${configPath}`, "Saved");

  outro("Configuration updated.");
}
