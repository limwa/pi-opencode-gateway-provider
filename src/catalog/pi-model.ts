import type {
  Api,
  Model,
  ModelCost,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { Match, Option, Schema } from "effect";

import { PROVIDER_ID } from "../constants.js";
import type { OpenCodeProviderConfig } from "../types.js";
import type { InternalModel } from "./normalize.js";

const OPENAI_COMPATIBLE_PACKAGES = new Set([
  "@ai-sdk/openai-compatible",
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

// Pi's built-in xAI catalog excludes these models from its Responses adapter.
const PI_UNSUPPORTED_XAI_RESPONSES_MODELS = new Set([
  "grok-3",
  "grok-3-fast",
  "grok-4.20-0309-non-reasoning",
  "grok-4.20-0309-reasoning",
  "grok-code-fast-1",
]);

const decodeStringRecord = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.String),
);

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringRecord(value: unknown): Record<string, string> {
  return decodeStringRecord(value).pipe(Option.getOrElse(() => ({})));
}

export function apiFor(
  npm: string,
  upstreamProviderId: string,
): Api | undefined {
  const mapped = Match.value(npm).pipe(
    Match.when(
      Match.is("@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"),
      () => "anthropic-messages" as const,
    ),
    Match.when(
      Match.is("@ai-sdk/openai", "@ai-sdk/xai"),
      () => "openai-responses" as const,
    ),
    Match.when(
      Match.is("@ai-sdk/google", "@ai-sdk/google-vertex"),
      () => "google-generative-ai" as const,
    ),
    Match.when("@ai-sdk/mistral", () => "mistral-conversations" as const),
    Match.orElse(() => undefined),
  );

  if (mapped) return mapped;
  if (OPENAI_COMPATIBLE_PACKAGES.has(npm)) return "openai-completions";
  return upstreamProviderId === "openai" ? "openai-responses" : undefined;
}

export function isInvalidBuiltInAlias(
  providerId: string,
  modelId: string,
): boolean {
  if (
    modelId === "gpt-5-chat-latest" &&
    ["openai", "github-copilot", "openrouter"].includes(providerId)
  ) {
    return true;
  }

  return providerId === "openrouter" && modelId === "openai/gpt-5-chat";
}

export function isUnsupportedXaiModel(
  providerId: string,
  modelId: string,
): boolean {
  return (
    providerId === "xai" && PI_UNSUPPORTED_XAI_RESPONSES_MODELS.has(modelId)
  );
}

function modelCost(model: InternalModel): ModelCost {
  const cost = model.cost;
  const tiers = (cost.tiers ?? [])
    .filter(
      ({ tier }) =>
        tier.type === "context" && Number.isFinite(tier.size) && tier.size >= 0,
    )
    .map(({ tier, ...price }) => ({
      input: finite(price.input),
      output: finite(price.output),
      cacheRead: finite(price.cache_read),
      cacheWrite: finite(price.cache_write),
      inputTokensAbove: tier.size,
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

export function timeoutFrom(
  options: Readonly<Record<string, unknown>>,
): number | undefined {
  const timeout = options["timeout"];
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : undefined;
}

function interpolateUrl(value: string): string {
  return value.replace(
    /\$\{([^}]+)\}/g,
    (token, name: string) => process.env[name] ?? token,
  );
}

export function createPiModel(
  upstreamProviderId: string,
  model: InternalModel,
  provider: OpenCodeProviderConfig,
  api: Api,
): Model<Api> {
  const options = provider.options ?? {};
  const configuredBaseUrl = options["baseURL"];
  const baseUrl = interpolateUrl(
    typeof configuredBaseUrl === "string" && configuredBaseUrl
      ? configuredBaseUrl
      : model.apiUrl,
  );
  const providerHeaders = stringRecord(options["headers"]);
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
    cost: modelCost(model),
    contextWindow: model.limit.context > 0 ? model.limit.context : 128_000,
    maxTokens: model.limit.output > 0 ? model.limit.output : 8_192,
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
  } else if (api === "openai-responses" && model.npm === "@ai-sdk/xai") {
    result.compat = { supportsLongCacheRetention: false };
  } else if (api === "anthropic-messages" && model.reasoningOptions) {
    result.compat = { forceAdaptiveThinking: true };
  }

  return result;
}
