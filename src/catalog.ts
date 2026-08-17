import {
  catalogModels,
  configuredModel,
  type InternalModel,
} from "./catalog/normalize.js";
import {
  apiFor,
  createPiModel,
  isInvalidBuiltInAlias,
  isUnsupportedXaiModel,
  timeoutFrom,
} from "./catalog/pi-model.js";
import type {
  ModelsCatalog,
  OpenCodeConfig,
  ResolvedCatalog,
  ResolvedGatewayModel,
  GatewayModel,
} from "./types.js";

function modelsForProvider(
  providerId: string,
  config: NonNullable<OpenCodeConfig["provider"]>[string],
  catalog: ModelsCatalog,
): Map<string, InternalModel> {
  const catalogProvider = catalog[providerId];
  const models = catalogProvider
    ? catalogModels(catalogProvider)
    : new Map<string, InternalModel>();

  // Config models override matching catalog entries and may also introduce
  // aliases or entirely custom models.
  for (const [key, modelConfig] of Object.entries(config.models ?? {})) {
    const existing = models.get(modelConfig.id ?? key);
    models.set(
      key,
      configuredModel(key, modelConfig, config, catalogProvider, existing),
    );
  }

  return models;
}

function skipReason(
  providerId: string,
  key: string,
  model: InternalModel,
  whitelist: ReadonlySet<string> | undefined,
  blacklist: ReadonlySet<string>,
  enableExperimentalModels: boolean,
): string | undefined {
  if (isInvalidBuiltInAlias(providerId, key)) return "internal alias";
  if (blacklist.has(key) || (whitelist && !whitelist.has(key))) {
    return "excluded by the gateway config";
  }
  if (model.status === "deprecated") return "deprecated";
  if (model.status === "alpha" && !enableExperimentalModels) {
    return "experimental models are disabled";
  }
  if (isUnsupportedXaiModel(providerId, key)) {
    return "This xAI model is not supported by Pi's Responses adapter";
  }

  return undefined;
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
  const configuredProviders = config.provider ?? {};

  const models: ResolvedGatewayModel[] = [];
  const skippedModels: ResolvedCatalog["skippedModels"] = [];
  const providerModelCounts: Record<string, number> = {};
  const warnings: string[] = [];

  for (const [providerId, providerConfig] of Object.entries(
    configuredProviders,
  )) {
    if (enabled && !enabled.has(providerId)) continue;
    if (disabled.has(providerId)) continue;

    const providerModels = modelsForProvider(
      providerId,
      providerConfig,
      catalog,
    );
    const whitelist = providerConfig.whitelist
      ? new Set(providerConfig.whitelist)
      : undefined;
    const blacklist = new Set(providerConfig.blacklist ?? []);
    let count = 0;

    for (const [key, model] of providerModels) {
      const reason = skipReason(
        providerId,
        key,
        model,
        whitelist,
        blacklist,
        enableExperimentalModels,
      );
      if (reason) {
        // OpenCode's own filters are silent. Only report incompatibilities that
        // explain why an otherwise enabled model is absent from Pi.
        if (reason.startsWith("This xAI")) {
          skippedModels.push({ id: `${providerId}/${key}`, reason });
        }
        continue;
      }

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
      if (!model.output.text) {
        skippedModels.push({
          id: piModel.id,
          reason: "Pi's language-model interface requires text output",
        });
        continue;
      }

      const timeoutMs = timeoutFrom(providerConfig.options ?? {});
      const metadata = {
        upstreamProviderId: providerId,
        upstreamModelId: model.apiId,
        npm: model.npm,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
      const gatewayModel = Object.assign(piModel, {
        opencodeGateway: metadata,
      }) as GatewayModel;

      models.push({ model: gatewayModel, ...metadata });
      count += 1;
    }

    if (count > 0) providerModelCounts[providerId] = count;
  }

  if (Object.keys(configuredProviders).length === 0) {
    warnings.push("The gateway config does not declare any providers.");
  }
  if (skippedModels.length > 0) {
    warnings.push(
      `${skippedModels.length} model${skippedModels.length === 1 ? " was" : "s were"} skipped because Pi cannot safely map their OpenCode API configuration.`,
    );
  }

  return { models, providerModelCounts, skippedModels, warnings };
}
