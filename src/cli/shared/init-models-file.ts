import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PROVIDER_PI_MODELS_FILE = "./models.custom.json";

const PROVIDER_PI_MODELS_TEMPLATE = {
  providers: {
    "custom-openai": {
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      apiKey: "CUSTOM_PROVIDER_AUTH_TOKEN",
      models: [
        {
          id: "example-model",
          name: "example-model",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 8192,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      ],
    },
  },
} as const;

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }

  return value;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolveModelsFilePath(configPath: string, value: string | undefined): string {
  const configDir = dirname(resolve(configPath));
  const resolvedValue = expandHome(value && value.trim().length > 0 ? value.trim() : DEFAULT_PROVIDER_PI_MODELS_FILE);
  return isAbsolute(resolvedValue) ? resolve(resolvedValue) : resolve(configDir, resolvedValue);
}

/**
 * Creates provider.pi models file only when missing.
 */
export async function ensureProviderPiModelsFile(
  configPath: string,
  providerConfig: Record<string, unknown>,
): Promise<{ created: boolean; path: string }> {
  const modelsFile = typeof providerConfig.modelsFile === "string" ? providerConfig.modelsFile : undefined;
  const targetPath = resolveModelsFilePath(configPath, modelsFile);

  if (await fileExists(targetPath)) {
    return { created: false, path: targetPath };
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(PROVIDER_PI_MODELS_TEMPLATE, null, 2)}\n`, "utf-8");
  return { created: true, path: targetPath };
}

