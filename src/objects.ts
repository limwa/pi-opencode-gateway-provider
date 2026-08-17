import type { JsonObject, JsonValue } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

export function deepMerge<T>(target: T, source: unknown): T {
  if (!isRecord(target) || !isRecord(source)) return source as T;

  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = result[key];
    result[key] =
      isRecord(current) && isRecord(value)
        ? deepMerge(current, value)
        : Array.isArray(value)
          ? [...value]
          : value;
  }
  return result as T;
}

export function asJsonObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? (value as JsonObject) : undefined;
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}
