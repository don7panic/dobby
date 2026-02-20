import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ExtensionManifest } from "../core/types.js";

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

export function parseExtensionManifest(value: unknown): ExtensionManifest {
  return manifestSchema.parse(value) as ExtensionManifest;
}

export async function readExtensionManifest(manifestPath: string): Promise<ExtensionManifest> {
  const raw = await readFile(manifestPath, "utf-8");
  return parseExtensionManifest(JSON.parse(raw));
}
