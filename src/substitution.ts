import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GatewayError } from "./errors.js";
import type { JsonObject } from "./types.js";

export interface SubstitutionOptions {
  env: Record<string, string>;
  source: string;
}

function sourceDirectory(source: string): string {
  return path.dirname(source);
}

async function substituteText(
  text: string,
  options: SubstitutionOptions,
): Promise<string> {
  let output = text.replace(/\{env:([^}]+)\}/g, (_match, name: string) => {
    return options.env[name] ?? process.env[name] ?? "";
  });

  const matches = Array.from(output.matchAll(/\{file:([^}]+)\}/g));
  for (const match of matches) {
    const token = match[0];
    let filename = match[1];
    if (!filename) continue;
    if (filename.startsWith("~/")) {
      filename = path.join(os.homedir(), filename.slice(2));
    }
    const resolved = path.isAbsolute(filename)
      ? filename
      : path.resolve(sourceDirectory(options.source), filename);
    let content: string;
    try {
      content = (await readFile(resolved, "utf8")).trim();
    } catch (cause) {
      throw new GatewayError({
        stage: "configuration",
        cause,
        message: `The gateway config references ${token}, but ${resolved} could not be read.`,
      });
    }
    output = output.replaceAll(token, JSON.stringify(content).slice(1, -1));
  }
  return output;
}

export async function substituteConfig(
  config: JsonObject,
  options: SubstitutionOptions,
): Promise<JsonObject> {
  const text = await substituteText(JSON.stringify(config), options);
  try {
    return JSON.parse(text) as JsonObject;
  } catch (cause) {
    throw new GatewayError({
      stage: "configuration",
      cause,
      message:
        "The OpenCode config became invalid JSON after environment and file substitution.",
    });
  }
}

export async function substituteString(
  value: string,
  options: SubstitutionOptions,
): Promise<string> {
  return substituteText(value, options);
}
