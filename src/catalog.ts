import type {
  Api,
  Model,
  ModelCost,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";

import { PROVIDER_ID } from "./constants.js";
import { deepMerge, isRecord } from "./objects.js";
import type {
  CatalogCost,
  CatalogModel,
  CatalogProvider,
  ModelsCatalog,
  OpenCodeConfig,
  OpenCodeModelConfig,
  OpenCodeProviderConfig,
  ResolvedCatalog,
  ResolvedGatewayModel,
  GatewayModel,
} from "./types.js";

interface InternalModel {
  key: string;
  apiId: string;
  name: string;
  npm: string;
  apiUrl: string;
  status: "alpha" | "beta" | "deprecated" | "active";
  reasoning: boolean;
  reasoningOptions?: CatalogModel["reasoning_options"];
  input: { text: boolean; image: boolean };
  cost: CatalogCost;
  limit: { context: number; output: number };
  options: Record<string, unknown>;
  headers: Record<string, string>;
}

const OPENAI_COMPATIBLE_PACKAGES = new Set([
  "@ai-sdk/openai-compatible",
  "@ai-sdk/xai",
  "@ai-sdk/groq",
  "@ai-sdk/cerebras",
  "@ai-sdk/deepinfra",
  "@ai-sdk/togetherai",
  "@ai-sdk/perplexity",
  "@ai-sdk/alibaba",
  "@openrouter/ai-sdk-provider",
  "venice-ai-sdk-provider",
  "ai-gateway-provider",
  "merge-gateway-ai-sdk-provider",
]);

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function camelCaseKeys(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_match, letter: string) =>
        letter.toUpperCase(),
      ),
      value,
    ]),
  );
}

function mergeCost(target: CatalogCost, source?: CatalogCost): CatalogCost {
  return source ? deepMerge(target, source) : structuredClone(target);
}

function fromCatalogModel(
  key: string,
  model: CatalogModel,
  provider: CatalogProvider,
): InternalModel {
  const modalities = model.modalities?.input;
  return {
    key,
    apiId: model.id || key,
    name: model.name || key,
    npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
    apiUrl: model.provider?.api ?? provider.api ?? "",
    status: model.status ?? "active",
    reasoning: model.reasoning ?? false,
    ...(model.reasoning_options
      ? { reasoningOptions: structuredClone(model.reasoning_options) }
      : {}),
    input: {
      text: modalities?.includes("text") ?? false,
      image: modalities?.includes("image") ?? false,
    },
    cost: structuredClone(model.cost ?? {}),
    limit: {
      context: finite(model.limit?.context),
      output: finite(model.limit?.output),
    },
    options: {},
    headers: {},
  };
}

function catalogModels(provider: CatalogProvider): Map<string, InternalModel> {
  const output = new Map<string, InternalModel>();
  for (const [key, value] of Object.entries(provider.models ?? {})) {
    if (!isRecord(value)) continue;
    const model = value as unknown as CatalogModel;
    const base = fromCatalogModel(key, model, provider);
    output.set(key, base);

    for (const [mode, modeConfig] of Object.entries(
      model.experimental?.modes ?? {},
    )) {
      const modeKey = `${model.id || key}-${mode}`;
      output.set(modeKey, {
        ...structuredClone(base),
        key: modeKey,
        name: `${base.name} ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`,
        cost: mergeCost(base.cost, modeConfig.cost),
        options: camelCaseKeys(modeConfig.provider?.body ?? {}),
        headers: { ...base.headers, ...modeConfig.provider?.headers },
      });
    }
  }
  return output;
}

function configuredModel(
  key: string,
  model: OpenCodeModelConfig,
  provider: OpenCodeProviderConfig,
  catalogProvider: CatalogProvider | undefined,
  existing: InternalModel | undefined,
): InternalModel {
  const configuredInput = model.modalities?.input;
  const cost = mergeCost(existing?.cost ?? {}, model.cost);
  return {
    key,
    apiId: model.id ?? existing?.apiId ?? key,
    name:
      model.name ??
      (model.id && model.id !== key ? key : (existing?.name ?? key)),
    npm:
      model.provider?.npm ??
      provider.npm ??
      existing?.npm ??
      catalogProvider?.npm ??
      "@ai-sdk/openai-compatible",
    apiUrl:
      model.provider?.api ??
      provider.api ??
      existing?.apiUrl ??
      catalogProvider?.api ??
      "",
    status: model.status ?? existing?.status ?? "active",
    reasoning: model.reasoning ?? existing?.reasoning ?? false,
    ...(existing?.reasoningOptions
      ? { reasoningOptions: structuredClone(existing.reasoningOptions) }
      : {}),
    input: {
      text: configuredInput?.includes("text") ?? existing?.input.text ?? true,
      image:
        configuredInput?.includes("image") ?? existing?.input.image ?? false,
    },
    cost,
    limit: {
      context: finite(model.limit?.context, existing?.limit.context ?? 0),
      output: finite(model.limit?.output, existing?.limit.output ?? 0),
    },
    options: deepMerge(existing?.options ?? {}, model.options ?? {}),
    headers: {
      ...(existing?.headers ?? {}),
      ...stringRecord(model.headers),
    },
  };
}

function apiFor(npm: string, upstreamProviderId: string): Api | undefined {
  if (
    npm === "@ai-sdk/anthropic" ||
    npm === "@ai-sdk/google-vertex/anthropic"
  ) {
    return "anthropic-messages";
  }
  if (npm === "@ai-sdk/openai") return "openai-responses";
  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") {
    return "google-generative-ai";
  }
  if (npm === "@ai-sdk/mistral") return "mistral-conversations";
  if (OPENAI_COMPATIBLE_PACKAGES.has(npm)) return "openai-completions";
  if (upstreamProviderId === "openai") return "openai-responses";
  return undefined;
}

function modelCost(cost: CatalogCost): ModelCost {
  const tiers = (cost.tiers ?? [])
    .filter(
      (tier) =>
        tier.tier?.type === "context" &&
        Number.isFinite(tier.tier.size) &&
        tier.tier.size >= 0,
    )
    .map((tier) => ({
      input: finite(tier.input),
      output: finite(tier.output),
      cacheRead: finite(tier.cache_read),
      cacheWrite: finite(tier.cache_write),
      inputTokensAbove: tier.tier.size,
    }));
  if (cost.context_over_200k) {
    tiers.push({
      input: finite(cost.context_over_200k.input),
      output: finite(cost.context_over_200k.output),
      cacheRead: finite(cost.context_over_200k.cache_read),
      cacheWrite: finite(cost.context_over_200k.cache_write),
      inputTokensAbove: 200_000,
    });
  }
  return {
    input: finite(cost.input),
    output: finite(cost.output),
    cacheRead: finite(cost.cache_read),
    cacheWrite: finite(cost.cache_write),
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

function thinkingLevelMap(model: InternalModel): ThinkingLevelMap | undefined {
  if (!model.reasoning) return undefined;
  const effort = model.reasoningOptions?.find(
    (option) => option.type === "effort",
  );
  if (!effort || effort.type !== "effort") return undefined;
  const values = new Set(effort.values);
  const supportsOff = values.has(null) || values.has("none");
  return {
    off: supportsOff ? "none" : null,
    minimal: values.has("minimal") ? "minimal" : null,
    low: values.has("low") ? "low" : null,
    medium: values.has("medium") ? "medium" : null,
    high: values.has("high") ? "high" : null,
    xhigh: values.has("xhigh") ? "xhigh" : null,
    max: values.has("max") ? "max" : null,
  };
}

function timeoutFrom(options: Record<string, unknown>): number | undefined {
  const timeout = options["timeout"];
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : undefined;
}

function interpolateUrl(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (token, name: string) => {
    return process.env[name] ?? token;
  });
}

function createPiModel(
  upstreamProviderId: string,
  model: InternalModel,
  provider: OpenCodeProviderConfig,
  api: Api,
): Model<Api> {
  const options = record(provider.options);
  const configuredBaseUrl = options["baseURL"];
  const baseUrl = interpolateUrl(
    typeof configuredBaseUrl === "string" && configuredBaseUrl
      ? configuredBaseUrl
      : model.apiUrl,
  );
  const providerHeaders = stringRecord(options["headers"]);
  const contextWindow = model.limit.context > 0 ? model.limit.context : 128_000;
  const maxTokens = model.limit.output > 0 ? model.limit.output : 8_192;
  const thinkingMap = thinkingLevelMap(model);

  const result: Model<Api> = {
    id: `${upstreamProviderId}/${model.key}`,
    name: `${model.name} (${provider.name ?? upstreamProviderId})`,
    api,
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: model.reasoning,
    ...(thinkingMap ? { thinkingLevelMap: thinkingMap } : {}),
    input: [
      ...(model.input.text ? (["text"] as const) : []),
      ...(model.input.image ? (["image"] as const) : []),
    ],
    cost: modelCost(model.cost),
    contextWindow,
    maxTokens,
    ...(Object.keys(model.options).length > 0
      ? { samplingParams: structuredClone(model.options) }
      : {}),
    headers: { ...providerHeaders, ...model.headers },
  };

  if (api === "openai-completions") {
    result.compat = {
      supportsReasoningEffort: model.reasoning,
      supportsStore: true,
    };
  } else if (api === "anthropic-messages" && model.reasoningOptions) {
    result.compat = { forceAdaptiveThinking: true };
  }
  return result;
}

function providerConfigRecord(
  config: OpenCodeConfig,
): Record<string, OpenCodeProviderConfig> {
  if (!isRecord(config.provider)) return {};
  return Object.fromEntries(
    Object.entries(config.provider).filter((entry) => isRecord(entry[1])),
  ) as Record<string, OpenCodeProviderConfig>;
}

export function resolveGatewayCatalog(
  config: OpenCodeConfig,
  catalog: ModelsCatalog,
  enableExperimentalModels = process.env[
    "OPENCODE_ENABLE_EXPERIMENTAL_MODELS"
  ] === "true" || process.env["OPENCODE_ENABLE_EXPERIMENTAL_MODELS"] === "1",
): ResolvedCatalog {
  const enabled = config.enabled_providers
    ? new Set(config.enabled_providers)
    : undefined;
  const disabled = new Set(config.disabled_providers ?? []);
  const models: ResolvedGatewayModel[] = [];
  const skippedModels: ResolvedCatalog["skippedModels"] = [];
  const providerModelCounts: Record<string, number> = {};
  const warnings: string[] = [];

  for (const [providerId, providerConfig] of Object.entries(
    providerConfigRecord(config),
  )) {
    if (enabled && !enabled.has(providerId)) continue;
    if (disabled.has(providerId)) continue;

    const catalogProvider = isRecord(catalog[providerId])
      ? (catalog[providerId] as CatalogProvider)
      : undefined;
    const providerModels = catalogProvider
      ? catalogModels(catalogProvider)
      : new Map<string, InternalModel>();

    for (const [key, value] of Object.entries(providerConfig.models ?? {})) {
      if (!isRecord(value)) continue;
      const modelConfig = value as OpenCodeModelConfig;
      const existing = providerModels.get(modelConfig.id ?? key);
      providerModels.set(
        key,
        configuredModel(
          key,
          modelConfig,
          providerConfig,
          catalogProvider,
          existing,
        ),
      );
    }

    const whitelist = providerConfig.whitelist
      ? new Set(providerConfig.whitelist)
      : undefined;
    const blacklist = new Set(providerConfig.blacklist ?? []);
    let count = 0;
    for (const [key, model] of providerModels) {
      if (blacklist.has(key) || (whitelist && !whitelist.has(key))) continue;
      if (model.status === "deprecated") continue;
      if (model.status === "alpha" && !enableExperimentalModels) continue;

      const api = apiFor(model.npm, providerId);
      if (!api) {
        skippedModels.push({
          id: `${providerId}/${key}`,
          reason: `Unsupported OpenCode provider package ${model.npm}`,
        });
        continue;
      }
      const piModel = createPiModel(providerId, model, providerConfig, api);
      if (!piModel.baseUrl) {
        skippedModels.push({
          id: piModel.id,
          reason: "The model has no API base URL",
        });
        continue;
      }
      if (piModel.input.length === 0) {
        skippedModels.push({
          id: piModel.id,
          reason: "Pi does not support any of the model input modalities",
        });
        continue;
      }
      const timeoutMs = timeoutFrom(record(providerConfig.options));
      const metadata = {
        upstreamProviderId: providerId,
        upstreamModelId: model.apiId,
        npm: model.npm,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
      const gatewayModel = Object.assign(piModel, {
        opencodeGateway: metadata,
      }) as GatewayModel;
      models.push({
        model: gatewayModel,
        upstreamProviderId: providerId,
        upstreamModelId: model.apiId,
        npm: model.npm,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      count += 1;
    }

    if (count > 0) providerModelCounts[providerId] = count;
  }

  if (Object.keys(providerConfigRecord(config)).length === 0) {
    warnings.push("The gateway config does not declare any providers.");
  }
  if (skippedModels.length > 0) {
    warnings.push(
      `${skippedModels.length} model${skippedModels.length === 1 ? " was" : "s were"} skipped because Pi cannot safely map their OpenCode API configuration.`,
    );
  }
  return { models, providerModelCounts, skippedModels, warnings };
}
