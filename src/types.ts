import type { Api, Model } from "@earendil-works/pi-ai";
import type { Effect } from "effect";

import type { GatewayError } from "./errors.js";

export type {
  CatalogCost,
  CatalogModel,
  CatalogProvider,
  GatewayCredential,
  JsonObject,
  JsonValue,
  ModelsCatalog,
  OpenCodeConfig,
  OpenCodeModelConfig,
  OpenCodeProviderConfig,
  WellKnownDocument,
} from "./schemas.js";

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
  timeoutMs?: number;
  description: string;
  reauthenticateOnForbidden?: boolean;
  redact?: readonly string[];
}

export type FetchImplementation = typeof globalThis.fetch;

export interface CommandExecution {
  command: readonly string[];
  onProgress?: (message: string) => void;
}

export type CommandRunner = (
  execution: CommandExecution,
) => Effect.Effect<string, GatewayError>;
