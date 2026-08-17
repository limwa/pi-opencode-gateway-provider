import { Effect } from "effect";

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

function redact(value: string, secrets: readonly string[] | undefined): string {
  let output = value;
  for (const secret of secrets ?? []) {
    if (secret) output = output.replaceAll(secret, "[REDACTED]");
  }
  return output;
}

function responseExcerpt(
  body: string,
  secrets: readonly string[] | undefined,
): string {
  const compact = redact(body, secrets).replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return ` Response: ${compact.slice(0, 240)}`;
}

export function fetchJson(
  fetchImplementation: FetchImplementation,
  url: string,
  options: FetchJsonOptions,
  stage: GatewayErrorStage,
): Effect.Effect<JsonValue, GatewayError> {
  return Effect.tryPromise({
    try: async (effectSignal) => {
      const timeout = AbortSignal.timeout(
        options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      );
      const signals = [effectSignal, timeout];
      if (options.signal) signals.push(options.signal);
      const signal = AbortSignal.any(signals);

      const response = await fetchImplementation(url, {
        ...(options.headers ? { headers: options.headers } : {}),
        redirect: "follow",
        signal,
      });
      const contentLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_HTTP_BODY_BYTES
      ) {
        throw new GatewayError({
          stage,
          message: `${options.description} declared more than ${MAX_HTTP_BODY_BYTES / 1024 / 1024} MiB of JSON.`,
        });
      }
      const body = await response.text();

      if (response.status === 403 && options.reauthenticateOnForbidden) {
        throw forbiddenError(options.description);
      }
      if (!response.ok) {
        throw new GatewayError({
          stage,
          status: response.status,
          message: `${options.description} failed (HTTP ${response.status} ${response.statusText || "request failed"}).${responseExcerpt(body, options.redact)}`,
        });
      }
      if (Buffer.byteLength(body, "utf8") > MAX_HTTP_BODY_BYTES) {
        throw new GatewayError({
          stage,
          message: `${options.description} returned more than ${MAX_HTTP_BODY_BYTES / 1024 / 1024} MiB of JSON.`,
        });
      }

      try {
        return JSON.parse(body) as JsonValue;
      } catch (cause) {
        throw new GatewayError({
          stage,
          cause,
          message: `${options.description} returned invalid JSON.${responseExcerpt(body, options.redact)}`,
        });
      }
    },
    catch: (cause) => {
      if (cause instanceof GatewayError) return cause;
      const aborted =
        options.signal?.aborted ||
        (cause instanceof Error &&
          (cause.name === "AbortError" || cause.name === "TimeoutError"));
      return new GatewayError({
        stage,
        cause,
        message: aborted
          ? `${options.description} was cancelled or timed out.`
          : `Failed to establish a connection while ${options.description.toLowerCase()}: ${redact(describeUnknownError(cause), options.redact)}`,
      });
    },
  });
}
