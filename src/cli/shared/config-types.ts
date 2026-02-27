export interface RawExtensionPackageConfig {
  package: string;
  enabled?: boolean;
}

export interface RawExtensionInstanceConfig {
  contributionId: string;
  config?: Record<string, unknown>;
}

export interface RawRouteProfile {
  projectRoot: string;
  tools?: "full" | "readonly";
  systemPromptFile?: string;
  allowMentionsOnly?: boolean;
  maxConcurrentTurns?: number;
  providerId?: string;
  sandboxId?: string;
  [key: string]: unknown;
}

export interface RawGatewayConfig {
  extensions?: {
    allowList?: RawExtensionPackageConfig[];
    [key: string]: unknown;
  };
  providers?: {
    defaultProviderId?: string;
    instances?: Record<string, RawExtensionInstanceConfig>;
    [key: string]: unknown;
  };
  connectors?: {
    instances?: Record<string, RawExtensionInstanceConfig>;
    [key: string]: unknown;
  };
  sandboxes?: {
    defaultSandboxId?: string;
    instances?: Record<string, RawExtensionInstanceConfig>;
    [key: string]: unknown;
  };
  routing?: {
    defaultRouteId?: string;
    routes?: Record<string, RawRouteProfile>;
    [key: string]: unknown;
  };
  data?: {
    rootDir?: string;
    dedupTtlMs?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NormalizedGatewayConfig extends RawGatewayConfig {
  extensions: {
    allowList: RawExtensionPackageConfig[];
    [key: string]: unknown;
  };
  providers: {
    defaultProviderId: string;
    instances: Record<string, RawExtensionInstanceConfig>;
    [key: string]: unknown;
  };
  connectors: {
    instances: Record<string, RawExtensionInstanceConfig>;
    [key: string]: unknown;
  };
  sandboxes: {
    defaultSandboxId: string;
    instances: Record<string, RawExtensionInstanceConfig>;
    [key: string]: unknown;
  };
  routing: {
    defaultRouteId?: string;
    routes: Record<string, RawRouteProfile>;
    [key: string]: unknown;
  };
  data: {
    rootDir: string;
    dedupTtlMs: number;
    [key: string]: unknown;
  };
}

export interface ContributionInstanceTemplate {
  id: string;
  contributionId: string;
  config: Record<string, unknown>;
}

export interface ContributionTemplatesByKind {
  providers: ContributionInstanceTemplate[];
  connectors: ContributionInstanceTemplate[];
  sandboxes: ContributionInstanceTemplate[];
}
