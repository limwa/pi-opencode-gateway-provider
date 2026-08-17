import { Effect } from "effect";

import {
  MODELS_CATALOG_URL,
  TOKEN_PLACEHOLDER,
  WELL_KNOWN_PATH,
} from "./constants.js";
import { describeUnknownError, GatewayError } from "./errors.js";
import { fetchJson } from "./http.js";
import { deepMerge, isRecord } from "./objects.js";
import {
  substituteConfig,
  substituteString,
  type SubstitutionOptions,
} from "./substitution.js";
import type {
  FetchImplementation,
  JsonObject,
  ModelsCatalog,
  OpenCodeConfig,
  WellKnownDocument,
} from "./types.js";

function substitutionEffect<A>(
  operation: () => Promise<A>,
): Effect.Effect<A, GatewayError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof GatewayError
        ? cause
        : new GatewayError({
            stage: "configuration",
            cause,
            message: `Failed to substitute values in the gateway config: ${describeUnknownError(cause)}`,
          }),
  });
}

export function loadOpenCodeConfig(
  fetchImplementation: FetchImplementation,
  gatewayUrl: string,
  wellKnown: WellKnownDocument,
  token: string,
  signal?: AbortSignal,
): Effect.Effect<OpenCodeConfig, GatewayError> {
  return Effect.gen(function* () {
    const wellKnownUrl = `${gatewayUrl}${WELL_KNOWN_PATH}`;
    const remoteSubstitution: SubstitutionOptions = {
      env: { [wellKnown.auth.env]: token },
      source: wellKnownUrl,
    };
    let fetched: JsonObject = {};

    if (wellKnown.remote_config) {
      const remoteConfig = wellKnown.remote_config;
      const remoteUrl = yield* substitutionEffect(() =>
        substituteString(remoteConfig.url, remoteSubstitution),
      );
      const safeRemoteUrl = remoteUrl.replaceAll(token, "[REDACTED]");
      const headerEntries = yield* Effect.all(
        Object.entries(remoteConfig.headers ?? {}).map(([name, value]) =>
          Effect.map(
            substitutionEffect(() =>
              substituteString(value, remoteSubstitution),
            ),
            (substituted) => [name, substituted] as const,
          ),
        ),
      );
      const response = yield* fetchJson(
        fetchImplementation,
        remoteUrl,
        {
          headers: Object.fromEntries(headerEntries),
          description: `Fetching OpenCode config from ${safeRemoteUrl}`,
          reauthenticateOnForbidden: true,
          redact: [token],
          ...(signal ? { signal } : {}),
        },
        "configuration",
      );
      if (!isRecord(response)) {
        return yield* new GatewayError({
          stage: "configuration",
          message: `OpenCode config from ${safeRemoteUrl} must be a JSON object.`,
        });
      }
      const nested = isRecord(response["config"])
        ? response["config"]
        : response;
      fetched = nested as JsonObject;
    }

    const merged = deepMerge<JsonObject>(wellKnown.config ?? {}, fetched);
    const substituted = yield* substitutionEffect(() =>
      substituteConfig(merged, {
        env: { [wellKnown.auth.env]: TOKEN_PLACEHOLDER },
        source: wellKnownUrl,
      }),
    );
    return substituted as OpenCodeConfig;
  });
}

export function loadModelsCatalog(
  fetchImplementation: FetchImplementation,
  signal?: AbortSignal,
): Effect.Effect<ModelsCatalog, GatewayError> {
  return Effect.flatMap(
    fetchJson(
      fetchImplementation,
      MODELS_CATALOG_URL,
      {
        description: "Fetching the OpenCode models.dev catalog",
        ...(signal ? { signal } : {}),
      },
      "catalog",
    ),
    (value) =>
      isRecord(value)
        ? Effect.succeed(value as unknown as ModelsCatalog)
        : Effect.fail(
            new GatewayError({
              stage: "catalog",
              message: "The OpenCode models.dev catalog must be a JSON object.",
            }),
          ),
  );
}
