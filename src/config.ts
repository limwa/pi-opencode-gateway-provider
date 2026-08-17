import { Effect, Schema } from "effect";
import { mergeDeep } from "remeda";

import {
  MODELS_CATALOG_URL,
  TOKEN_PLACEHOLDER,
  WELL_KNOWN_PATH,
} from "./constants.js";
import { describeSchemaError, GatewayError } from "./errors.js";
import { GatewayHttpClient } from "./http.js";
import { ModelsCatalogSchema, OpenCodeConfigSchema } from "./schemas.js";
import {
  substituteConfig,
  substituteString,
  type SubstitutionOptions,
} from "./substitution.js";
import type { JsonObject, ModelsCatalog, WellKnownDocument } from "./types.js";

const decodeJsonObject = Schema.decodeUnknownEffect(
  Schema.Record(Schema.String, Schema.Json),
);
const decodeOpenCodeConfig = Schema.decodeUnknownEffect(OpenCodeConfigSchema);
const decodeModelsCatalog = Schema.decodeUnknownEffect(ModelsCatalogSchema);

function configurationDecodeError(source: string, cause: Schema.SchemaError) {
  return new GatewayError({
    stage: "configuration",
    cause,
    message: `OpenCode config from ${source} is invalid: ${describeSchemaError(cause)}.`,
  });
}

function configObjectError(source: string, cause: Schema.SchemaError) {
  return new GatewayError({
    stage: "configuration",
    cause,
    message: `OpenCode config from ${source} must be a JSON object.`,
  });
}

export const loadOpenCodeConfig = Effect.fn("loadOpenCodeConfig")(function* (
  gatewayUrl: string,
  wellKnown: WellKnownDocument,
  token: string,
) {
  const http = yield* GatewayHttpClient;
  const wellKnownUrl = `${gatewayUrl}${WELL_KNOWN_PATH}`;
  const remoteSubstitution: SubstitutionOptions = {
    env: { [wellKnown.auth.env]: token },
    source: wellKnownUrl,
  };

  let fetched: JsonObject = {};
  if (wellKnown.remote_config) {
    const remoteUrl = yield* substituteString(
      wellKnown.remote_config.url,
      remoteSubstitution,
    );
    const safeRemoteUrl = remoteUrl.replaceAll(token, "[REDACTED]");

    const headerEntries = yield* Effect.forEach(
      Object.entries(wellKnown.remote_config.headers ?? {}),
      ([name, value]) =>
        substituteString(value, remoteSubstitution).pipe(
          Effect.map((substituted) => [name, substituted] as const),
        ),
    );

    const response = yield* http.getJson(
      remoteUrl,
      {
        headers: Object.fromEntries(headerEntries),
        description: `Fetching OpenCode config from ${safeRemoteUrl}`,
        reauthenticateOnForbidden: true,
        redact: [token],
      },
      "configuration",
    );

    const root = yield* decodeJsonObject(response).pipe(
      Effect.mapError((cause) => configObjectError(safeRemoteUrl, cause)),
    );
    const nested = root["config"];

    fetched =
      nested === undefined
        ? root
        : yield* decodeJsonObject(nested).pipe(
            Effect.mapError((cause) => configObjectError(safeRemoteUrl, cause)),
          );
  }

  // OpenCode gives remote config precedence and applies substitutions after
  // combining the embedded and fetched documents.
  const merged = mergeDeep(wellKnown.config ?? {}, fetched) as JsonObject;
  const substituted = yield* substituteConfig(merged, {
    env: { [wellKnown.auth.env]: TOKEN_PLACEHOLDER },
    source: wellKnownUrl,
  });

  return yield* decodeOpenCodeConfig(substituted).pipe(
    Effect.mapError((cause) => configurationDecodeError(wellKnownUrl, cause)),
  );
});

export const loadModelsCatalog = Effect.fn("loadModelsCatalog")(
  function* (): Effect.fn.Return<
    ModelsCatalog,
    GatewayError,
    GatewayHttpClient
  > {
    const http = yield* GatewayHttpClient;
    const value = yield* http.getJson(
      MODELS_CATALOG_URL,
      { description: "Fetching the OpenCode models.dev catalog" },
      "catalog",
    );

    return yield* decodeModelsCatalog(value).pipe(
      Effect.mapError(
        (cause) =>
          new GatewayError({
            stage: "catalog",
            cause,
            message: `The OpenCode models.dev catalog is invalid: ${describeSchemaError(cause)}.`,
          }),
      ),
    );
  },
);
