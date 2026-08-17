import { Effect, Schema } from "effect";

import { WELL_KNOWN_PATH } from "./constants.js";
import { describeSchemaError, GatewayError } from "./errors.js";
import { GatewayHttpClient } from "./http.js";
import { WellKnownDocumentSchema } from "./schemas.js";
import type { WellKnownDocument } from "./types.js";

const decodeWellKnown = Schema.decodeUnknownEffect(WellKnownDocumentSchema);

export const normalizeGatewayUrl = Effect.fn("normalizeGatewayUrl")(function* (
  input: string,
) {
  const value = input.trim();
  if (!value) {
    return yield* new GatewayError({
      stage: "host",
      message: "Enter a gateway host, for example gateway.example.com.",
    });
  }

  const url = yield* Effect.try({
    try: () => new URL(value.includes("://") ? value : `https://${value}`),
    catch: (cause) =>
      new GatewayError({
        stage: "host",
        cause,
        message: `The gateway host ${JSON.stringify(value)} is not a valid URL.`,
      }),
  });

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return yield* new GatewayError({
      stage: "host",
      message: "The gateway URL must use HTTPS or HTTP.",
    });
  }

  if (url.username || url.password || url.search || url.hash) {
    return yield* new GatewayError({
      stage: "host",
      message:
        "The gateway URL must not contain credentials, a query string, or a fragment.",
    });
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
});

export const parseWellKnown = Effect.fn("parseWellKnown")(
  (
    value: unknown,
    url: string,
  ): Effect.Effect<WellKnownDocument, GatewayError> =>
    decodeWellKnown(value).pipe(
      Effect.mapError(
        (cause) =>
          new GatewayError({
            stage: "discovery",
            cause,
            message: `Gateway metadata from ${url} is invalid: ${describeSchemaError(cause)}. Check the gateway's /.well-known/opencode response.`,
          }),
      ),
    ),
);

export const discoverGateway = Effect.fn("discoverGateway")(function* (
  gatewayUrl: string,
) {
  const http = yield* GatewayHttpClient;
  const url = `${gatewayUrl}${WELL_KNOWN_PATH}`;

  const value = yield* http.getJson(
    url,
    { description: `Loading OpenCode Gateway metadata from ${url}` },
    "discovery",
  );

  return yield* parseWellKnown(value, url);
});
