import type {
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  MODELS_CATALOG_URL,
  NON_EXPIRING_TOKEN_TIMESTAMP,
  TOKEN_PLACEHOLDER,
} from "../src/constants.js";
import { GatewayService } from "../src/gateway-service.js";
import type { FetchImplementation } from "../src/types.js";
import {
  catalogProvider,
  jsonResponse,
  jwt,
  modelsCatalog,
} from "./helpers.js";

function interaction(host = "gateway.example"): ProviderAuthInteraction {
  return {
    signal: new AbortController().signal,
    prompt: vi.fn(async () => host),
    notify: vi.fn(),
  };
}

function gatewayFetch(): FetchImplementation {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://gateway.example/.well-known/opencode") {
      return jsonResponse({
        auth: { command: ["gateway-login"], env: "TOKEN" },
        config: {
          provider: {
            anthropic: {
              options: {
                baseURL: "https://gateway.example/anthropic",
                headers: { "cf-access-token": "{env:TOKEN}" },
              },
            },
          },
        },
      });
    }
    if (url === MODELS_CATALOG_URL) {
      return jsonResponse(modelsCatalog(catalogProvider()));
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as unknown as FetchImplementation;
}

describe("GatewayService", () => {
  it("performs login, prepares models, and records opaque tokens as non-expiring", async () => {
    const fetch = gatewayFetch();
    const commandRunner = vi.fn(async () => "opaque-secret-token");
    const service = await Effect.runPromise(
      GatewayService.make({ fetch, commandRunner, now: () => 1_000 }),
    );
    const credential = await service.login(interaction());

    expect(credential).toMatchObject({
      gatewayUrl: "https://gateway.example",
      tokenKind: "opaque",
      expires: NON_EXPIRING_TOKEN_TIMESTAMP,
      access: "opaque-secret-token",
    });
    expect(commandRunner).toHaveBeenCalledWith(
      expect.objectContaining({ command: ["gateway-login"] }),
    );
    const status = await Effect.runPromise(service.state.snapshot());
    expect(status).toMatchObject({
      phase: "ready",
      modelCount: 1,
      providerModelCounts: { anthropic: 1 },
    });

    const models = await service.fetchModels(
      credential,
      new AbortController().signal,
    );
    expect(models[0]?.headers).toEqual({
      "cf-access-token": TOKEN_PLACEHOLDER,
    });
    expect(JSON.stringify(models)).not.toContain("opaque-secret-token");
    expect(service.materializeToken(models[0]?.headers)).toEqual({
      "cf-access-token": "opaque-secret-token",
    });
    const signal = new AbortController().signal;
    expect(service.materializeToken({ signal }).signal).toBe(signal);
    expect(service.redactToken("failed: opaque-secret-token")).toBe(
      "failed: [REDACTED]",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an expired JWT before accepting credentials", async () => {
    const service = await Effect.runPromise(
      GatewayService.make({
        fetch: gatewayFetch(),
        commandRunner: async () => jwt({ exp: 1 }),
        now: () => 2_000,
      }),
    );
    await expect(service.login(interaction())).rejects.toThrow(
      "already-expired JWT",
    );
    expect(await Effect.runPromise(service.state.snapshot())).toMatchObject({
      phase: "error",
      lastError: expect.stringContaining(
        "already-expired JWT",
      ) as unknown as string,
    });
  });

  it("refuses non-interactive refresh with an actionable message", async () => {
    const service = await Effect.runPromise(GatewayService.make());
    await expect(
      service.refresh(
        {
          type: "oauth",
          access: "token",
          refresh: "",
          expires: 0,
        } satisfies OAuthCredential,
        new AbortController().signal,
      ),
    ).rejects.toThrow("/login");
  });
});
