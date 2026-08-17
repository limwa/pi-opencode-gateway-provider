import type {
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MODELS_CATALOG_URL,
  NON_EXPIRING_TOKEN_TIMESTAMP,
  TOKEN_PLACEHOLDER,
} from "../src/constants.js";
import { GatewayService } from "../src/gateway-service.js";
import type { GatewayManagedRuntime } from "../src/provider.js";
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

const runtimes: GatewayManagedRuntime[] = [];

function makeRuntime(options: Parameters<typeof GatewayService.layer>[0] = {}) {
  const runtime = ManagedRuntime.make(GatewayService.layer(options));
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("GatewayService", () => {
  it("performs login, prepares models, and records opaque tokens as non-expiring", async () => {
    const fetch = gatewayFetch();
    const commandRunner = vi.fn(() => Effect.succeed("opaque-secret-token"));
    const runtime = makeRuntime({ fetch, commandRunner, now: () => 1_000 });
    const authInteraction = interaction();

    const credential = await runtime.runPromise(
      GatewayService.use((service) => service.login(authInteraction)),
    );

    expect(credential).toMatchObject({
      gatewayUrl: "https://gateway.example",
      tokenKind: "opaque",
      expires: NON_EXPIRING_TOKEN_TIMESTAMP,
      access: "opaque-secret-token",
      issuedAt: 1_000,
    });
    expect(commandRunner).toHaveBeenCalledWith(
      expect.objectContaining({ command: ["gateway-login"] }),
    );

    const status = await runtime.runPromise(
      GatewayService.use((service) => service.state.snapshot),
    );
    expect(status).toMatchObject({
      phase: "ready",
      modelCount: 1,
      lastRefreshAt: 1_000,
      providerModelCounts: { anthropic: 1 },
    });

    const models = await runtime.runPromise(
      GatewayService.use((service) => service.fetchModels(credential)),
    );
    expect(models[0]?.headers).toEqual({
      "cf-access-token": TOKEN_PLACEHOLDER,
    });
    expect(JSON.stringify(models)).not.toContain("opaque-secret-token");
    expect(
      await runtime.runPromise(
        GatewayService.use((service) => service.activeToken),
      ),
    ).toBe("opaque-secret-token");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an expired JWT before accepting credentials", async () => {
    const runtime = makeRuntime({
      fetch: gatewayFetch(),
      commandRunner: () => Effect.succeed(jwt({ exp: 1 })),
      now: () => 2_000,
    });

    await expect(
      runtime.runPromise(
        GatewayService.use((service) => service.login(interaction())),
      ),
    ).rejects.toThrow("already-expired JWT");

    expect(
      await runtime.runPromise(
        GatewayService.use((service) => service.state.snapshot),
      ),
    ).toMatchObject({
      phase: "error",
      lastError: expect.stringContaining(
        "already-expired JWT",
      ) as unknown as string,
    });
  });

  it("refuses non-interactive refresh with an actionable message", async () => {
    const runtime = makeRuntime();
    const credential = {
      type: "oauth",
      access: "token",
      refresh: "",
      expires: 0,
    } satisfies OAuthCredential;

    await expect(
      runtime.runPromise(
        GatewayService.use((service) => service.refresh(credential)),
      ),
    ).rejects.toThrow("/login");
  });
});
