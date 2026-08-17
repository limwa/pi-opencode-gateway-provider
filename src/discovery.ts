import { Effect } from "effect";

import { WELL_KNOWN_PATH } from "./constants.js";
import { GatewayError } from "./errors.js";
import { fetchJson } from "./http.js";
import { isRecord } from "./objects.js";
import type {
  FetchImplementation,
  JsonObject,
  WellKnownDocument,
} from "./types.js";

export function normalizeGatewayUrl(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new GatewayError({
      stage: "host",
      message: "Enter a gateway host, for example opencode.cloudflare.dev.",
    });
  }

  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch (cause) {
    throw new GatewayError({
      stage: "host",
      cause,
      message: `The gateway host ${JSON.stringify(value)} is not a valid URL.`,
    });
  }

  if (!["https:", "http:"].includes(url.protocol)) {
    throw new GatewayError({
      stage: "host",
      message: "The gateway URL must use HTTPS or HTTP.",
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new GatewayError({
      stage: "host",
      message:
        "The gateway URL must not contain credentials, a query string, or a fragment.",
    });
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every((entry) => typeof entry[1] === "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

export function parseWellKnown(value: unknown, url: string): WellKnownDocument {
  if (!isRecord(value) || !isRecord(value["auth"])) {
    throw new GatewayError({
      stage: "discovery",
      message: `Gateway metadata from ${url} does not contain an auth object.`,
    });
  }
  const auth = value["auth"];
  const command = auth["command"];
  const env = auth["env"];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string" && part.length > 0) ||
    typeof env !== "string" ||
    !env.trim()
  ) {
    throw new GatewayError({
      stage: "discovery",
      message:
        "Gateway metadata has an invalid auth command or token environment variable.",
    });
  }

  let remoteConfig: WellKnownDocument["remote_config"];
  if (value["remote_config"] !== undefined) {
    const remote = value["remote_config"];
    if (!isRecord(remote) || typeof remote["url"] !== "string") {
      throw new GatewayError({
        stage: "discovery",
        message: "Gateway metadata has an invalid remote_config object.",
      });
    }
    const headers = stringRecord(remote["headers"]);
    if (remote["headers"] !== undefined && !headers) {
      throw new GatewayError({
        stage: "discovery",
        message: "Gateway metadata has invalid remote_config headers.",
      });
    }
    remoteConfig = {
      url: remote["url"],
      ...(headers ? { headers } : {}),
    };
  }

  return {
    auth: { command: [...command], env },
    ...(isRecord(value["config"])
      ? { config: value["config"] as JsonObject }
      : {}),
    ...(remoteConfig ? { remote_config: remoteConfig } : {}),
  };
}

export function discoverGateway(
  fetchImplementation: FetchImplementation,
  gatewayUrl: string,
  signal?: AbortSignal,
): Effect.Effect<WellKnownDocument, GatewayError> {
  const url = `${gatewayUrl}${WELL_KNOWN_PATH}`;
  return Effect.flatMap(
    fetchJson(
      fetchImplementation,
      url,
      {
        description: `Loading OpenCode Gateway metadata from ${url}`,
        ...(signal ? { signal } : {}),
      },
      "discovery",
    ),
    (value) =>
      Effect.try({
        try: () => parseWellKnown(value, url),
        catch: (cause) =>
          cause instanceof GatewayError
            ? cause
            : new GatewayError({
                stage: "discovery",
                cause,
                message: `Could not understand gateway metadata from ${url}.`,
              }),
      }),
  );
}
