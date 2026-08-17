import { Schema } from "effect";

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const StringRecordSchema = Schema.Record(Schema.String, Schema.String);
const NonBlankString = Schema.Trimmed.check(Schema.isMinLength(1));

// These schemas intentionally describe only fields consumed by the extension.
// Effect strips unrelated OpenCode fields while still validating every field
// that influences Pi's provider and model definitions.

const ProviderApi = Schema.Struct({
  npm: Schema.optionalKey(Schema.String),
  api: Schema.optionalKey(Schema.String),
});

const Modality = Schema.Literals(["text", "audio", "image", "video", "pdf"]);
const Modalities = Schema.Struct({
  input: Schema.optionalKey(Schema.Array(Modality)),
  output: Schema.optionalKey(Schema.Array(Modality)),
});

const Interleaved = Schema.Union([
  Schema.Boolean,
  Schema.String,
  Schema.Struct({ field: Schema.String }),
]);

const CatalogCost = Schema.Struct({
  input: Schema.optionalKey(Schema.Finite),
  output: Schema.optionalKey(Schema.Finite),
  cache_read: Schema.optionalKey(Schema.Finite),
  cache_write: Schema.optionalKey(Schema.Finite),
  tiers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        cache_read: Schema.optionalKey(Schema.Finite),
        cache_write: Schema.optionalKey(Schema.Finite),
        tier: Schema.Struct({ type: Schema.String, size: Schema.Finite }),
      }),
    ),
  ),
  context_over_200k: Schema.optionalKey(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optionalKey(Schema.Finite),
      cache_write: Schema.optionalKey(Schema.Finite),
    }),
  ),
});

const ReasoningOption = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("effort"),
    values: Schema.Array(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ type: Schema.Literal("toggle") }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optionalKey(Schema.Finite),
    max: Schema.optionalKey(Schema.Finite),
  }),
]);

const ModelStatus = Schema.Literals(["alpha", "beta", "deprecated", "active"]);

const ExperimentalMode = Schema.Struct({
  cost: Schema.optionalKey(CatalogCost),
  provider: Schema.optionalKey(
    Schema.Struct({
      body: Schema.optionalKey(JsonObjectSchema),
      headers: Schema.optionalKey(StringRecordSchema),
    }),
  ),
});

export const CatalogModelSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optionalKey(Schema.String),
  release_date: Schema.optionalKey(Schema.String),
  attachment: Schema.optionalKey(Schema.Boolean),
  reasoning: Schema.optionalKey(Schema.Boolean),
  temperature: Schema.optionalKey(Schema.Boolean),
  tool_call: Schema.optionalKey(Schema.Boolean),
  reasoning_options: Schema.optionalKey(Schema.Array(ReasoningOption)),
  interleaved: Schema.optionalKey(Interleaved),
  cost: Schema.optionalKey(CatalogCost),
  limit: Schema.optionalKey(
    Schema.Struct({
      context: Schema.optionalKey(Schema.Finite),
      input: Schema.optionalKey(Schema.Finite),
      output: Schema.optionalKey(Schema.Finite),
    }),
  ),
  modalities: Schema.optionalKey(Modalities),
  experimental: Schema.optionalKey(
    Schema.Struct({
      modes: Schema.optionalKey(Schema.Record(Schema.String, ExperimentalMode)),
    }),
  ),
  status: Schema.optionalKey(ModelStatus),
  provider: Schema.optionalKey(ProviderApi),
});

export const CatalogProviderSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  env: Schema.optionalKey(Schema.Array(Schema.String)),
  api: Schema.optionalKey(Schema.String),
  npm: Schema.optionalKey(Schema.String),
  models: Schema.Record(Schema.String, CatalogModelSchema),
});

export const ModelsCatalogSchema = Schema.Record(
  Schema.String,
  CatalogProviderSchema,
);

export const OpenCodeModelConfigSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  family: Schema.optionalKey(Schema.String),
  release_date: Schema.optionalKey(Schema.String),
  attachment: Schema.optionalKey(Schema.Boolean),
  reasoning: Schema.optionalKey(Schema.Boolean),
  temperature: Schema.optionalKey(Schema.Boolean),
  tool_call: Schema.optionalKey(Schema.Boolean),
  interleaved: Schema.optionalKey(Interleaved),
  cost: Schema.optionalKey(CatalogCost),
  limit: Schema.optionalKey(
    Schema.Struct({
      context: Schema.optionalKey(Schema.Finite),
      input: Schema.optionalKey(Schema.Finite),
      output: Schema.optionalKey(Schema.Finite),
    }),
  ),
  modalities: Schema.optionalKey(Modalities),
  experimental: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(ModelStatus),
  provider: Schema.optionalKey(ProviderApi),
  options: Schema.optionalKey(JsonObjectSchema),
  headers: Schema.optionalKey(StringRecordSchema),
});

export const OpenCodeProviderConfigSchema = Schema.Struct({
  api: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  npm: Schema.optionalKey(Schema.String),
  whitelist: Schema.optionalKey(Schema.Array(Schema.String)),
  blacklist: Schema.optionalKey(Schema.Array(Schema.String)),
  options: Schema.optionalKey(JsonObjectSchema),
  models: Schema.optionalKey(
    Schema.Record(Schema.String, OpenCodeModelConfigSchema),
  ),
});

export const OpenCodeConfigSchema = Schema.Struct({
  enabled_providers: Schema.optionalKey(Schema.Array(Schema.String)),
  disabled_providers: Schema.optionalKey(Schema.Array(Schema.String)),
  provider: Schema.optionalKey(
    Schema.Record(Schema.String, OpenCodeProviderConfigSchema),
  ),
});

export const WellKnownDocumentSchema = Schema.Struct({
  auth: Schema.Struct({
    command: Schema.NonEmptyArray(Schema.NonEmptyString),
    env: NonBlankString,
  }),
  config: Schema.optionalKey(JsonObjectSchema),
  remote_config: Schema.optionalKey(
    Schema.Struct({
      url: NonBlankString,
      headers: Schema.optionalKey(StringRecordSchema),
    }),
  ),
});

export const GatewayCredentialSchema = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Finite,
  gatewayUrl: Schema.String,
  tokenEnv: Schema.String,
  issuedAt: Schema.Finite,
  tokenKind: Schema.Literals(["jwt", "opaque"]),
});

export type CatalogCost = (typeof CatalogCost)["Type"];
export type CatalogModel = (typeof CatalogModelSchema)["Type"];
export type CatalogProvider = (typeof CatalogProviderSchema)["Type"];
export type GatewayCredential = (typeof GatewayCredentialSchema)["Type"];
export type JsonObject = (typeof JsonObjectSchema)["Type"];
export type JsonValue = Schema.Json;
export type ModelsCatalog = (typeof ModelsCatalogSchema)["Type"];
export type OpenCodeConfig = (typeof OpenCodeConfigSchema)["Type"];
export type OpenCodeModelConfig = (typeof OpenCodeModelConfigSchema)["Type"];
export type OpenCodeProviderConfig =
  (typeof OpenCodeProviderConfigSchema)["Type"];
export type WellKnownDocument = (typeof WellKnownDocumentSchema)["Type"];
