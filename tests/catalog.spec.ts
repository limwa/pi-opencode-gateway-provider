import { describe, expect, it } from "vitest";

import { resolveGatewayCatalog } from "../src/catalog.js";
import { TOKEN_PLACEHOLDER } from "../src/constants.js";
import type { OpenCodeConfig } from "../src/types.js";
import { catalogProvider, modelsCatalog } from "./helpers.js";

describe("OpenCode catalog resolution", () => {
  it("inherits models for a declared provider with no model entries", () => {
    const resolved = resolveGatewayCatalog(
      {
        provider: {
          anthropic: {
            options: {
              baseURL: "https://gateway.example/anthropic",
              headers: { "cf-access-token": TOKEN_PLACEHOLDER },
            },
          },
        },
      },
      modelsCatalog(catalogProvider()),
    );
    expect(resolved.models).toHaveLength(1);
    expect(resolved.models[0]?.model).toMatchObject({
      id: "anthropic/claude-test",
      api: "anthropic-messages",
      baseUrl: "https://gateway.example/anthropic",
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 32_000,
      headers: { "cf-access-token": TOKEN_PLACEHOLDER },
    });
    expect(resolved.models[0]?.model.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
  });

  it("applies enabled/disabled providers and whitelist/blacklist in OpenCode order", () => {
    const anthropic = catalogProvider({
      models: {
        ...catalogProvider().models,
        blocked: {
          ...catalogProvider().models["claude-test"]!,
          id: "blocked",
          name: "Blocked",
        },
      },
    });
    const openai = catalogProvider({ id: "openai", name: "OpenAI" });
    const base: OpenCodeConfig = {
      enabled_providers: ["anthropic", "openai"],
      disabled_providers: ["openai"],
      provider: {
        anthropic: {
          whitelist: ["claude-test", "blocked"],
          blacklist: ["blocked"],
          options: { baseURL: "https://gateway.example/anthropic" },
        },
        openai: { options: { baseURL: "https://gateway.example/openai" } },
      },
    };
    const resolved = resolveGatewayCatalog(
      base,
      modelsCatalog(anthropic, openai),
    );
    expect(resolved.models.map((entry) => entry.model.id)).toEqual([
      "anthropic/claude-test",
    ]);
  });

  it("adds aliases without removing the source model and preserves the real request ID", () => {
    const resolved = resolveGatewayCatalog(
      {
        provider: {
          anthropic: {
            options: { baseURL: "https://gateway.example/anthropic" },
            models: {
              "team-default": {
                id: "claude-test",
                name: "Team Default",
                options: { custom_flag: true },
              },
            },
          },
        },
      },
      modelsCatalog(catalogProvider()),
    );
    expect(resolved.models.map((entry) => entry.model.id)).toEqual([
      "anthropic/claude-test",
      "anthropic/team-default",
    ]);
    const alias = resolved.models[1]!;
    expect(alias.upstreamModelId).toBe("claude-test");
    expect(alias.model.opencodeGateway.upstreamModelId).toBe("claude-test");
    expect(alias.model.samplingParams).toEqual({ custom_flag: true });
  });

  it("adds models.dev experimental modes and filters deprecated/alpha models", () => {
    const provider = catalogProvider({
      models: {
        base: {
          ...catalogProvider().models["claude-test"]!,
          id: "base",
          experimental: {
            modes: {
              fast: {
                cost: { input: 1, output: 2 },
                provider: { body: { service_tier: "priority" } },
              },
            },
          },
        },
        openai: {
          ...catalogProvider().models["claude-test"]!,
          id: "openai",
          provider: { npm: "@ai-sdk/openai" },
          experimental: {
            modes: {
              pro: { provider: { body: { reasoning: { mode: "pro" } } } },
            },
          },
        },
        old: {
          ...catalogProvider().models["claude-test"]!,
          id: "old",
          status: "deprecated",
        },
        preview: {
          ...catalogProvider().models["claude-test"]!,
          id: "preview",
          status: "alpha",
        },
      },
    });
    const config = {
      provider: {
        anthropic: { options: { baseURL: "https://gateway.example" } },
      },
    };
    const stable = resolveGatewayCatalog(
      config,
      modelsCatalog(provider),
      false,
    );
    expect(stable.models.map((entry) => entry.model.id)).toEqual([
      "anthropic/base",
      "anthropic/base-fast",
      "anthropic/openai",
      "anthropic/openai-pro",
    ]);
    expect(stable.models[1]?.model.samplingParams).toEqual({
      serviceTier: "priority",
    });
    expect(
      stable.models.find((entry) => entry.model.id === "anthropic/openai-pro")
        ?.model.samplingParams,
    ).toEqual({ reasoningMode: "pro" });
    const experimental = resolveGatewayCatalog(
      config,
      modelsCatalog(provider),
      true,
    );
    expect(experimental.models.map((entry) => entry.model.id)).toContain(
      "anthropic/preview",
    );
  });

  it("removes providers with no models and reports unsupported APIs", () => {
    const resolved = resolveGatewayCatalog(
      {
        provider: {
          empty: { models: {} },
          custom: {
            api: "https://gateway.example/custom",
            npm: "custom-proprietary-sdk",
            models: { model: { limit: { context: 10, output: 5 } } },
          },
        },
      },
      {},
    );
    expect(resolved.models).toEqual([]);
    expect(resolved.skippedModels).toEqual([
      {
        id: "custom/model",
        reason: "Unsupported OpenCode provider package custom-proprietary-sdk",
      },
    ]);
  });

  it("uses Pi's Responses adapter for xAI and omits non-text generators", () => {
    const provider = catalogProvider({
      id: "xai",
      name: "xAI",
      npm: "@ai-sdk/xai",
      models: {
        grok: {
          ...catalogProvider().models["claude-test"]!,
          id: "grok",
          name: "Grok",
          provider: { npm: "@ai-sdk/xai" },
        },
        image: {
          ...catalogProvider().models["claude-test"]!,
          id: "image",
          name: "Image generator",
          provider: { npm: "@ai-sdk/xai" },
          modalities: { input: ["text"], output: ["image"] },
        },
      },
    });
    const resolved = resolveGatewayCatalog(
      {
        provider: {
          xai: { options: { baseURL: "https://gateway.example/xai" } },
        },
      },
      modelsCatalog(provider),
    );

    expect(
      resolved.models.map((entry) => [entry.model.id, entry.model.api]),
    ).toEqual([["xai/grok", "openai-responses"]]);
    expect(resolved.models[0]?.model.compat).toEqual({
      supportsLongCacheRetention: false,
    });
    expect(resolved.skippedModels).toContainEqual({
      id: "xai/image",
      reason: "Pi's language-model interface requires text output",
    });
  });

  it("expands OpenCode provider URL environment placeholders", () => {
    const previous = process.env["GATEWAY_ORIGIN"];
    process.env["GATEWAY_ORIGIN"] = "https://gateway.example";
    try {
      const resolved = resolveGatewayCatalog(
        {
          provider: {
            anthropic: {
              options: { baseURL: "${GATEWAY_ORIGIN}/anthropic" },
            },
          },
        },
        modelsCatalog(catalogProvider()),
      );
      expect(resolved.models[0]?.model.baseUrl).toBe(
        "https://gateway.example/anthropic",
      );
    } finally {
      if (previous === undefined) delete process.env["GATEWAY_ORIGIN"];
      else process.env["GATEWAY_ORIGIN"] = previous;
    }
  });
});
