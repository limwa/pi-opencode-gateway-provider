import type { Context, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";

import { MODELS_CATALOG_URL } from "../src/constants.js";
import { GatewayService } from "../src/gateway-service.js";
import { createGatewayProvider } from "../src/provider.js";
import type { FetchImplementation } from "../src/types.js";
import { jsonResponse } from "./helpers.js";

describe("gateway provider requests", () => {
  it("uses the upstream alias ID and turns HTTP 403 into a login instruction", async () => {
    const discoveryFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url === "https://gateway.example/.well-known/opencode") {
        return jsonResponse({
          auth: { command: ["login"], env: "TOKEN" },
          config: {
            provider: {
              custom: {
                npm: "@ai-sdk/openai-compatible",
                api: "https://gateway.example/v1",
                options: { headers: { "x-gateway-token": "{env:TOKEN}" } },
                models: {
                  alias: {
                    id: "real-model-id",
                    name: "Alias",
                    limit: { context: 8_000, output: 1_000 },
                  },
                },
              },
            },
          },
        });
      }
      if (url === MODELS_CATALOG_URL) return jsonResponse({});

      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as FetchImplementation;
    const runtime = ManagedRuntime.make(
      GatewayService.layer({
        fetch: discoveryFetch,
        commandRunner: () => Effect.succeed("secret-token"),
      }),
    );

    try {
      const authInteraction: ProviderAuthInteraction = {
        signal: new AbortController().signal,
        prompt: async () => "gateway.example",
        notify: () => {},
      };
      const credential = await runtime.runPromise(
        GatewayService.use((service) => service.login(authInteraction)),
      );
      await runtime.runPromise(
        GatewayService.use((service) => service.toAuth(credential)),
      );

      const provider = createGatewayProvider(runtime);
      await provider.refreshModels!({
        credential,
        allowNetwork: true,
        signal: new AbortController().signal,
        publish: async (publication) => {
          publication.update?.();
          return true;
        },
      });
      const model = provider.getModels()[0]!;
      expect(model.id).toBe("custom/alias");

      const requestFetch = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { model: string };
          expect(body.model).toBe("real-model-id");
          expect(new Headers(init?.headers).get("x-gateway-token")).toBe(
            "secret-token",
          );
          return new Response("forbidden", {
            status: 403,
            statusText: "Forbidden",
          });
        },
      );
      const context: Context = { messages: [], tools: [] };
      const result = await provider
        .streamSimple(model, context, {
          apiKey: "placeholder",
          fetch: requestFetch as typeof globalThis.fetch,
          maxRetries: 0,
        })
        .result();

      expect(requestFetch).toHaveBeenCalledOnce();
      expect(result.model).toBe("custom/alias");
      expect(result.errorMessage).toContain("403");
      expect(result.errorMessage).toContain("/login");
    } finally {
      await runtime.dispose();
    }
  });
});
