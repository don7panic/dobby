export interface RawExtensionPackageConfig {
  package: string;
  enabled?: boolean;
}

export interface RawExtensionItemConfig {
  type: string;
  [key: string]: unknown;
}

export interface RawRouteDefaults {
  projectRoot?: string;
  provider?: string;
  sandbox?: string;
  tools?: "full" | "readonly";
  mentions?: "required" | "optional";
  [key: string]: unknown;
}

export interface RawRouteProfile {
  projectRoot?: string;
  tools?: "full" | "readonly";
  systemPromptFile?: string;
  mentions?: "required" | "optional";
  provider?: string;
  sandbox?: string;
  [key: string]: unknown;
}

export interface RawDefaultBindingConfig {
  route: string;
  [key: string]: unknown;
}

export interface RawBindingConfig {
  connector: string;
  source: {
    type: "channel" | "chat";
    id: string;
    [key: string]: unknown;
  };
  route: string;
  [key: string]: unknown;
}

export interface RawGatewayConfig {
  extensions?: {
    allowList?: RawExtensionPackageConfig[];
    [key: string]: unknown;
  };
  providers?: {
    default?: string;
    items?: Record<string, RawExtensionItemConfig>;
    [key: string]: unknown;
  };
  connectors?: {
    items?: Record<string, RawExtensionItemConfig>;
    [key: string]: unknown;
  };
  sandboxes?: {
    default?: string;
    items?: Record<string, RawExtensionItemConfig>;
    [key: string]: unknown;
  };
  routes?: {
    defaults?: RawRouteDefaults;
    items?: Record<string, RawRouteProfile>;
    [key: string]: unknown;
  };
  bindings?: {
    default?: RawDefaultBindingConfig;
    items?: Record<string, RawBindingConfig>;
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
    default: string;
    items: Record<string, RawExtensionItemConfig>;
    [key: string]: unknown;
  };
  connectors: {
    items: Record<string, RawExtensionItemConfig>;
    [key: string]: unknown;
  };
  sandboxes: {
    default: string;
    items: Record<string, RawExtensionItemConfig>;
    [key: string]: unknown;
  };
  routes: {
    default: RawRouteDefaults;
    items: Record<string, RawRouteProfile>;
    [key: string]: unknown;
  };
  bindings: {
    default?: RawDefaultBindingConfig;
    items: Record<string, RawBindingConfig>;
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
  type: string;
  config: Record<string, unknown>;
}

export interface ContributionTemplatesByKind {
  providers: ContributionInstanceTemplate[];
  connectors: ContributionInstanceTemplate[];
  sandboxes: ContributionInstanceTemplate[];
}
