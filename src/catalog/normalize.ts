import { Schema } from "effect";
import { mergeDeep } from "remeda";

import type {
  CatalogCost,
  CatalogModel,
  CatalogProvider,
  OpenCodeModelConfig,
  OpenCodeProviderConfig,
} from "../types.js";

export interface InternalModel {
  readonly key: string;
  readonly apiId: string;
  readonly name: string;
  readonly npm: string;
  readonly apiUrl: string;
  readonly status: "alpha" | "beta" | "deprecated" | "active";
  readonly reasoning: boolean;
  readonly reasoningOptions?: CatalogModel["reasoning_options"];
  readonly input: { readonly text: boolean; readonly image: boolean };
  readonly output: { readonly text: boolean };
  readonly cost: CatalogCost;
  readonly limit: { readonly context: number; readonly output: number };
  readonly options: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

const isReasoningMode = Schema.is(Schema.Struct({ mode: Schema.String }));

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function camelCaseKeys(
  input: Readonly<Record<string, unknown>>,
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

function modeOptions(
  model: InternalModel,
  body: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!body) return model.options;

  const options = camelCaseKeys(body);
  const reasoning = body["reasoning"];
  if (model.npm !== "@ai-sdk/openai" || !isReasoningMode(reasoning)) {
    return options;
  }

  const { reasoning: _reasoning, ...rest } = options;
  return { ...rest, reasoningMode: reasoning.mode };
}

function mergeCost(target: CatalogCost, source?: CatalogCost): CatalogCost {
  return source
    ? (mergeDeep(target, source) as CatalogCost)
    : structuredClone(target);
}

function fromCatalogModel(
  key: string,
  model: CatalogModel,
  provider: CatalogProvider,
): InternalModel {
  const input = model.modalities?.input;
  const output = model.modalities?.output;

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
      text: input?.includes("text") ?? false,
      image: input?.includes("image") ?? false,
    },
    output: { text: output?.includes("text") ?? false },
    cost: structuredClone(model.cost ?? {}),
    limit: {
      context: finite(model.limit?.context),
      output: finite(model.limit?.output),
    },
    options: {},
    headers: {},
  };
}

export function catalogModels(
  provider: CatalogProvider,
): Map<string, InternalModel> {
  const models = new Map<string, InternalModel>();

  for (const [key, model] of Object.entries(provider.models)) {
    const base = fromCatalogModel(key, model, provider);
    models.set(key, base);

    // OpenCode's models.dev catalog can expose mode-specific synthetic models.
    for (const [mode, modeConfig] of Object.entries(
      model.experimental?.modes ?? {},
    )) {
      const modeKey = `${model.id || key}-${mode}`;
      models.set(modeKey, {
        ...structuredClone(base),
        key: modeKey,
        name: `${base.name} ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`,
        cost: mergeCost(base.cost, modeConfig.cost),
        options: modeOptions(base, modeConfig.provider?.body),
        headers: { ...base.headers, ...modeConfig.provider?.headers },
      });
    }
  }

  return models;
}

export function configuredModel(
  key: string,
  model: OpenCodeModelConfig,
  provider: OpenCodeProviderConfig,
  catalogProvider: CatalogProvider | undefined,
  existing: InternalModel | undefined,
): InternalModel {
  const configuredInput = model.modalities?.input;

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
    output: {
      text:
        model.modalities?.output?.includes("text") ??
        existing?.output.text ??
        true,
    },
    cost: mergeCost(existing?.cost ?? {}, model.cost),
    limit: {
      context: finite(model.limit?.context, existing?.limit.context ?? 0),
      output: finite(model.limit?.output, existing?.limit.output ?? 0),
    },
    options: mergeDeep(existing?.options ?? {}, model.options ?? {}),
    headers: { ...(existing?.headers ?? {}), ...(model.headers ?? {}) },
  };
}
