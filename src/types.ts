import type { Api, Model, OAuthCredential } from "@earendil-works/pi-ai";

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

export interface WellKnownDocument {
  auth: {
    command: string[];
    env: string;
  };
  config?: JsonObject;
  remote_config?: {
    url: string;
    headers?: Record<string, string>;
  };
}

export interface GatewayCredential extends OAuthCredential {
  gatewayUrl: string;
  tokenEnv: string;
  issuedAt: number;
  tokenKind: "jwt" | "opaque";
}

export interface CatalogCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: Array<{
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    tier: { type: string; size: number };
  }>;
  context_over_200k?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
}

export interface CatalogModel {
  id: string;
  name: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  reasoning_options?: Array<
    | { type: "effort"; values: Array<string | null> }
    | { type: "toggle" }
    | { type: "budget_tokens"; min?: number; max?: number }
  >;
  interleaved?: boolean | string | { field: string };
  cost?: CatalogCost;
  limit?: { context?: number; input?: number; output?: number };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  experimental?: {
    modes?: Record<
      string,
      {
        cost?: CatalogCost;
        provider?: {
          body?: Record<string, unknown>;
          headers?: Record<string, string>;
        };
      }
    >;
  };
  status?: "alpha" | "beta" | "deprecated" | "active";
  provider?: { npm?: string; api?: string };
}

export interface CatalogProvider {
  id: string;
  name: string;
  env?: string[];
  api?: string;
  npm?: string;
  models: Record<string, CatalogModel>;
}

export type ModelsCatalog = Record<string, CatalogProvider>;

export interface OpenCodeModelConfig {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  interleaved?: boolean | string | { field: string };
  cost?: CatalogCost;
  limit?: { context?: number; input?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  experimental?: boolean;
  status?: "alpha" | "beta" | "deprecated" | "active";
  provider?: { npm?: string; api?: string };
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
  variants?: Record<string, { disabled?: boolean; [key: string]: unknown }>;
}

export interface OpenCodeProviderConfig {
  api?: string;
  name?: string;
  env?: string[];
  id?: string;
  npm?: string;
  whitelist?: string[];
  blacklist?: string[];
  options?: Record<string, unknown>;
  models?: Record<string, OpenCodeModelConfig>;
}

export interface OpenCodeConfig {
  enabled_providers?: string[];
  disabled_providers?: string[];
  provider?: Record<string, OpenCodeProviderConfig>;
  [key: string]: unknown;
}

export interface ResolvedGatewayModel {
  model: GatewayModel;
  upstreamProviderId: string;
  upstreamModelId: string;
  npm: string;
  timeoutMs?: number;
}

export interface GatewayModelMetadata {
  upstreamProviderId: string;
  upstreamModelId: string;
  npm: string;
  timeoutMs?: number;
}

export interface GatewayModel extends Model<Api> {
  /** Persisted with Pi's dynamic catalog so aliased model IDs work offline. */
  opencodeGateway: GatewayModelMetadata;
}

export interface ResolvedCatalog {
  models: ResolvedGatewayModel[];
  providerModelCounts: Record<string, number>;
  skippedModels: Array<{ id: string; reason: string }>;
  warnings: string[];
}

export interface GatewayStatus {
  phase: "not-configured" | "authenticating" | "ready" | "error";
  gatewayUrl?: string;
  tokenKind?: "jwt" | "opaque";
  tokenExpiresAt?: number;
  configuredAt?: number;
  lastRefreshAt?: number;
  modelCount: number;
  providerModelCounts: Record<string, number>;
  skippedModelCount: number;
  warnings: string[];
  lastError?: string;
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  description: string;
  reauthenticateOnForbidden?: boolean;
  redact?: readonly string[];
}

export type FetchImplementation = typeof globalThis.fetch;

export interface CommandExecution {
  command: readonly string[];
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

export type CommandRunner = (execution: CommandExecution) => Promise<string>;
