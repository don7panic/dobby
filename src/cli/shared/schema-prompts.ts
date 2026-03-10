import {
  cancel,
  confirm,
  isCancel,
  multiselect,
  note,
  password,
  select,
  text,
} from "@clack/prompts";
import JSON5 from "json5";

interface PromptConfigFromSchemaOptions {
  title?: string;
  promptDefaultedFields?: boolean;
}

interface FieldPromptDescriptor {
  key: string;
  schema: Record<string, unknown>;
  required: boolean;
  hasDefault: boolean;
  existingValue: unknown;
  initialValue: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function stringifyPreview(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isPrimitive(value)) {
    return String(value);
  }
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

function schemaType(schema: Record<string, unknown>): string | undefined {
  const raw = schema.type;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    const firstStringType = raw.find((item) => typeof item === "string");
    return typeof firstStringType === "string" ? firstStringType : undefined;
  }
  return undefined;
}

function schemaEnum(schema: Record<string, unknown>): Array<string | number | boolean> | null {
  if (!Array.isArray(schema.enum)) {
    return null;
  }

  const normalized = schema.enum.filter((item) => isPrimitive(item)) as Array<string | number | boolean>;
  return normalized.length > 0 ? normalized : null;
}

function schemaRequiredSet(schema: Record<string, unknown>): Set<string> {
  if (!Array.isArray(schema.required)) {
    return new Set<string>();
  }
  return new Set(schema.required.filter((item) => typeof item === "string"));
}

function schemaProperties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  if (!isRecord(schema.properties)) {
    return {};
  }

  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (isRecord(value)) {
      result[key] = value;
    }
  }
  return result;
}

function hasSchemaDefault(schema: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(schema, "default");
}

function shouldPromptInMinimalMode(field: FieldPromptDescriptor): boolean {
  if (!field.hasDefault && field.required) {
    return true;
  }

  if (field.existingValue !== undefined) {
    return true;
  }

  return false;
}

function isSensitiveStringField(key: string): boolean {
  return /(token|secret|api[-_]?key)$/i.test(key);
}

async function promptNumberField(params: {
  message: string;
  required: boolean;
  initialValue: unknown;
  integer: boolean;
  existingValue: unknown;
}): Promise<number | undefined> {
  while (true) {
    const result = await text({
      message: params.message,
      initialValue: stringifyPreview(params.initialValue),
      placeholder: params.integer ? "integer" : "number",
    });
    if (isCancel(result)) {
      cancel("Configuration cancelled.");
      throw new Error("Configuration cancelled.");
    }

    const raw = String(result ?? "").trim();
    if (raw.length === 0) {
      if (params.required && params.existingValue === undefined) {
        await note("This field is required.", "Validation");
        continue;
      }
      return typeof params.existingValue === "number" ? params.existingValue : undefined;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      await note("Please enter a valid number.", "Validation");
      continue;
    }
    if (params.integer && !Number.isInteger(parsed)) {
      await note("Please enter an integer.", "Validation");
      continue;
    }
    return parsed;
  }
}

async function promptJsonField(params: {
  message: string;
  required: boolean;
  initialValue: unknown;
  expected: "object" | "array";
  existingValue: unknown;
}): Promise<unknown> {
  while (true) {
    const result = await text({
      message: params.message,
      initialValue: stringifyPreview(params.initialValue),
      placeholder: params.expected === "object" ? '{"key":"value"}' : '["value"]',
    });
    if (isCancel(result)) {
      cancel("Configuration cancelled.");
      throw new Error("Configuration cancelled.");
    }

    const raw = String(result ?? "").trim();
    if (raw.length === 0) {
      if (params.required && params.existingValue === undefined) {
        await note("This field is required.", "Validation");
        continue;
      }
      return params.existingValue;
    }

    try {
      const parsed = JSON5.parse(raw);
      if (params.expected === "object" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
        await note("Please enter a JSON object.", "Validation");
        continue;
      }
      if (params.expected === "array" && !Array.isArray(parsed)) {
        await note("Please enter a JSON array.", "Validation");
        continue;
      }
      return parsed;
    } catch (error) {
      await note(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "Validation");
    }
  }
}

async function promptArrayField(params: {
  key: string;
  schema: Record<string, unknown>;
  required: boolean;
  initialValue: unknown;
  existingValue: unknown;
}): Promise<unknown> {
  const itemSchema = isRecord(params.schema.items) ? params.schema.items : {};
  const itemEnum = schemaEnum(itemSchema);
  if (itemEnum && itemEnum.length > 0) {
    const current = Array.isArray(params.initialValue) ? params.initialValue : [];
    const initialValues = current.filter((item) => itemEnum.includes(item as string | number | boolean))
      .map((item) => String(item));
    const result = await multiselect({
      message: `${params.key}${params.required ? " (required)" : ""}`,
      options: itemEnum.map((item) => ({
        value: String(item),
        label: String(item),
      })),
      initialValues,
      required: params.required,
    });
    if (isCancel(result)) {
      cancel("Configuration cancelled.");
      throw new Error("Configuration cancelled.");
    }

    return (result as string[]).map((value) => itemEnum.find((candidate) => String(candidate) === value) ?? value);
  }

  return promptJsonField({
    message: `${params.key}${params.required ? " (required)" : ""} (JSON array)`,
    required: params.required,
    initialValue: params.initialValue,
    expected: "array",
    existingValue: params.existingValue,
  });
}

async function promptFieldValue(params: {
  key: string;
  schema: Record<string, unknown>;
  required: boolean;
  initialValue: unknown;
  existingValue: unknown;
}): Promise<unknown> {
  const { key, schema, required, initialValue, existingValue } = params;
  const enumValues = schemaEnum(schema);
  const type = schemaType(schema);
  const description = typeof schema.description === "string" ? schema.description.trim() : "";
  const message = `${key}${required ? " (required)" : ""}${description ? ` - ${description}` : ""}`;

  if (enumValues && enumValues.length > 0) {
    const fallback = enumValues[0]!;
    const initialCandidate = enumValues.includes(initialValue as string | number | boolean)
      ? (initialValue as string | number | boolean)
      : enumValues.includes(existingValue as string | number | boolean)
        ? (existingValue as string | number | boolean)
        : fallback;
    const result = await select({
      message,
      options: enumValues.map((value) => ({
        value: String(value),
        label: String(value),
      })),
      initialValue: String(initialCandidate),
    });
    if (isCancel(result)) {
      cancel("Configuration cancelled.");
      throw new Error("Configuration cancelled.");
    }
    return enumValues.find((value) => String(value) === String(result)) ?? result;
  }

  if (type === "boolean") {
    const result = await confirm({
      message,
      initialValue: typeof initialValue === "boolean"
        ? initialValue
        : typeof existingValue === "boolean"
          ? existingValue
          : false,
    });
    if (isCancel(result)) {
      cancel("Configuration cancelled.");
      throw new Error("Configuration cancelled.");
    }
    return result === true;
  }

  if (type === "integer" || type === "number") {
    return promptNumberField({
      message,
      required,
      initialValue,
      integer: type === "integer",
      existingValue,
    });
  }

  if (type === "array") {
    return promptArrayField({
      key,
      schema,
      required,
      initialValue,
      existingValue,
    });
  }

  if (type === "object") {
    return promptJsonField({
      message: `${message} (JSON object)`,
      required,
      initialValue,
      expected: "object",
      existingValue,
    });
  }

  if (isSensitiveStringField(key)) {
    while (true) {
      const result = await password({
        message,
        mask: "*",
      });
      if (isCancel(result)) {
        cancel("Configuration cancelled.");
        throw new Error("Configuration cancelled.");
      }

      const raw = String(result ?? "").trim();
      if (raw.length === 0) {
        if (required && existingValue === undefined) {
          await note("This field is required.", "Validation");
          continue;
        }
        return existingValue;
      }

      return raw;
    }
  }

  while (true) {
    const result = await text({
      message,
      initialValue: stringifyPreview(initialValue),
    });
    if (isCancel(result)) {
      cancel("Configuration cancelled.");
      throw new Error("Configuration cancelled.");
    }

    const raw = String(result ?? "").trim();
    if (raw.length === 0) {
      if (required && existingValue === undefined) {
        await note("This field is required.", "Validation");
        continue;
      }
      return existingValue;
    }

    return raw;
  }
}

/**
 * Prompts one extension config object from a contribution JSON Schema.
 * Currently supports top-level schema properties and falls back to JSON input for complex fields.
 */
export async function promptConfigFromSchema(
  schema: Record<string, unknown>,
  currentConfig: Record<string, unknown>,
  options?: PromptConfigFromSchemaOptions,
): Promise<Record<string, unknown>> {
  const properties = schemaProperties(schema);
  const required = schemaRequiredSet(schema);

  if (options?.title) {
    await note(options.title, "Configure");
  }

  if (Object.keys(properties).length === 0) {
    return structuredClone(currentConfig);
  }

  const next = structuredClone(currentConfig);
  const fieldDescriptors: FieldPromptDescriptor[] = Object.entries(properties).map(([key, fieldSchema]) => {
    const existingValue = next[key];
    const defaultValue = fieldSchema.default;
    const initialValue = existingValue !== undefined ? existingValue : defaultValue;
    return {
      key,
      schema: fieldSchema,
      required: required.has(key),
      hasDefault: hasSchemaDefault(fieldSchema),
      existingValue,
      initialValue,
    };
  });

  const minimalFields = fieldDescriptors.filter((field) => shouldPromptInMinimalMode(field));
  const advancedFields = fieldDescriptors.filter((field) => !minimalFields.includes(field));

  for (const field of minimalFields) {
    const value = await promptFieldValue({
      key: field.key,
      schema: field.schema,
      required: field.required,
      initialValue: field.initialValue,
      existingValue: field.existingValue,
    });
    if (value === undefined) {
      continue;
    }
    next[field.key] = value;
  }

  if (advancedFields.length > 0) {
    const shouldPromptAdvanced = options?.promptDefaultedFields === true
      ? true
      : await confirm({
        message: "Configure advanced options (defaults can be kept)?",
        initialValue: false,
      });
    if (isCancel(shouldPromptAdvanced)) {
      cancel("Configuration cancelled.");
      throw new Error("Configuration cancelled.");
    }

    if (shouldPromptAdvanced === true) {
      for (const field of advancedFields) {
        const value = await promptFieldValue({
          key: field.key,
          schema: field.schema,
          required: field.required,
          initialValue: field.initialValue,
          existingValue: field.existingValue,
        });
        if (value === undefined) {
          continue;
        }
        next[field.key] = value;
      }
    }
  }

  return next;
}
