import { Context, Effect, Layer, Schema } from "effect";

import { MAX_HTTP_BODY_BYTES, REQUEST_TIMEOUT_MS } from "./constants.js";
import {
  describeUnknownError,
  forbiddenError,
  GatewayError,
  type GatewayErrorStage,
} from "./errors.js";
import type {
  FetchImplementation,
  FetchJsonOptions,
  JsonValue,
} from "./types.js";

export const GatewayFetch = Context.Reference<FetchImplementation>(
  "pi-opencode-gateway-provider/GatewayFetch",
  { defaultValue: () => globalThis.fetch },
);

function redact(value: string, secrets: readonly string[] = []): string {
  return secrets.reduce(
    (output, secret) =>
      secret ? output.replaceAll(secret, "[REDACTED]") : output,
    value,
  );
}

function responseExcerpt(body: string, secrets?: readonly string[]): string {
  const compact = redact(body, secrets).replace(/\s+/g, " ").trim();
  return compact ? ` Response: ${compact.slice(0, 240)}` : "";
}

function connectionError(
  cause: unknown,
  description: string,
  stage: GatewayErrorStage,
  secrets?: readonly string[],
): GatewayError {
  return new GatewayError({
    stage,
    cause,
    message: `Failed to establish a connection while ${description.toLowerCase()}: ${redact(describeUnknownError(cause), secrets)}`,
  });
}

const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Json),
);

const requestJson = Effect.fn("GatewayHttpClient.requestJson")(function* (
  fetchImplementation: FetchImplementation,
  url: string,
  options: FetchJsonOptions,
  stage: GatewayErrorStage,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetchImplementation(url, {
        ...(options.headers ? { headers: options.headers } : {}),
        redirect: "follow",
        signal,
      }),
    catch: (cause) =>
      connectionError(cause, options.description, stage, options.redact),
  });

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_BODY_BYTES) {
    return yield* new GatewayError({
      stage,
      message: `${options.description} declared more than ${MAX_HTTP_BODY_BYTES / 1024 / 1024} MiB of JSON.`,
    });
  }

  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      connectionError(cause, options.description, stage, options.redact),
  });

  if (response.status === 403 && options.reauthenticateOnForbidden) {
    return yield* forbiddenError(options.description);
  }

  if (!response.ok) {
    return yield* new GatewayError({
      stage,
      status: response.status,
      message: `${options.description} failed (HTTP ${response.status} ${response.statusText || "request failed"}).${responseExcerpt(body, options.redact)}`,
    });
  }

  if (Buffer.byteLength(body, "utf8") > MAX_HTTP_BODY_BYTES) {
    return yield* new GatewayError({
      stage,
      message: `${options.description} returned more than ${MAX_HTTP_BODY_BYTES / 1024 / 1024} MiB of JSON.`,
    });
  }

  return yield* decodeJson(body).pipe(
    Effect.mapError(
      (cause) =>
        new GatewayError({
          stage,
          cause,
          message: `${options.description} returned invalid JSON.${responseExcerpt(body, options.redact)}`,
        }),
    ),
  );
});

export class GatewayHttpClient extends Context.Service<
  GatewayHttpClient,
  {
    getJson(
      url: string,
      options: FetchJsonOptions,
      stage: GatewayErrorStage,
    ): Effect.Effect<JsonValue, GatewayError>;
  }
>()("pi-opencode-gateway-provider/GatewayHttpClient") {
  static readonly layer = Layer.effect(
    GatewayHttpClient,
    Effect.gen(function* () {
      const fetchImplementation = yield* GatewayFetch;

      const getJson = Effect.fn("GatewayHttpClient.getJson")(
        (url: string, options: FetchJsonOptions, stage: GatewayErrorStage) =>
          requestJson(fetchImplementation, url, options, stage).pipe(
            Effect.timeoutOrElse({
              duration: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
              orElse: () =>
                Effect.fail(
                  new GatewayError({
                    stage,
                    message: `${options.description} timed out.`,
                  }),
                ),
            }),
          ),
      );

      return GatewayHttpClient.of({ getJson });
    }),
  );

  static layerWith(fetchImplementation: FetchImplementation) {
    return this.layer.pipe(
      Layer.provide(Layer.succeed(GatewayFetch, fetchImplementation)),
    );
  }
}
