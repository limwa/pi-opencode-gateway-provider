import type { CatalogProvider, ModelsCatalog } from "../src/types.js";

export function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

export function catalogProvider(
  overrides: Partial<CatalogProvider> = {},
): CatalogProvider {
  return {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    api: "https://api.anthropic.com/v1",
    models: {
      "claude-test": {
        id: "claude-test",
        name: "Claude Test",
        release_date: "2026-01-01",
        attachment: true,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        temperature: true,
        tool_call: true,
        cost: {
          input: 3,
          output: 15,
          cache_read: 0.3,
          cache_write: 3.75,
        },
        limit: { context: 200_000, output: 32_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
    ...overrides,
  };
}

export function modelsCatalog(...providers: CatalogProvider[]): ModelsCatalog {
  return Object.fromEntries(
    providers.map((provider) => [provider.id, provider]),
  );
}
