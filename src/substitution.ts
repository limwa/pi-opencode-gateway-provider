import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect, Schema } from "effect";

import { GatewayError } from "./errors.js";
import type { JsonObject } from "./types.js";

export interface SubstitutionOptions {
  env: Readonly<Record<string, string>>;
  source: string;
}

const decodeJsonObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

function resolveFile(filename: string, source: string): string {
  const expanded = filename.startsWith("~/")
    ? path.join(os.homedir(), filename.slice(2))
    : filename;

  return path.isAbsolute(expanded)
    ? expanded
    : path.resolve(path.dirname(source), expanded);
}

/** Mirrors OpenCode's text-level {env:...} and {file:...} substitution. */
const substituteText = Effect.fn("substituteText")(function* (
  text: string,
  options: SubstitutionOptions,
) {
  let output = text.replace(
    /\{env:([^}]+)\}/g,
    (_match, name: string) => options.env[name] ?? process.env[name] ?? "",
  );

  // File contents are JSON-escaped because substitution happens inside serialized
  // config strings in OpenCode. Processing matches in order preserves duplicates.
  for (const match of output.matchAll(/\{file:([^}]+)\}/g)) {
    const token = match[0];
    const filename = match[1];
    if (!filename) continue;

    const resolved = resolveFile(filename, options.source);
    const content = yield* Effect.tryPromise({
      try: () => readFile(resolved, "utf8"),
      catch: (cause) =>
        new GatewayError({
          stage: "configuration",
          cause,
          message: `The gateway config references ${token}, but ${resolved} could not be read.`,
        }),
    });

    output = output.replaceAll(
      token,
      JSON.stringify(content.trim()).slice(1, -1),
    );
  }

  return output;
});

export const substituteConfig = Effect.fn("substituteConfig")(function* (
  config: JsonObject,
  options: SubstitutionOptions,
) {
  const text = yield* substituteText(JSON.stringify(config), options);

  return yield* decodeJsonObject(text).pipe(
    Effect.mapError(
      (cause) =>
        new GatewayError({
          stage: "configuration",
          cause,
          message:
            "The OpenCode config became invalid JSON after environment and file substitution.",
        }),
    ),
  );
});

export const substituteString = Effect.fn("substituteString")(
  (value: string, options: SubstitutionOptions) =>
    substituteText(value, options),
);
