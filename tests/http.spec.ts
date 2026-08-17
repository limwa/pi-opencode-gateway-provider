import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { GatewayHttpClient } from "../src/http.js";
import type { FetchImplementation } from "../src/types.js";

function getJson(fetch: FetchImplementation, timeoutMs = 1_000) {
  return GatewayHttpClient.use((http) =>
    http.getJson(
      "https://gateway.example/config",
      { description: "Fetching test config", timeoutMs },
      "configuration",
    ),
  ).pipe(Effect.provide(GatewayHttpClient.layerWith(fetch)));
}

describe("GatewayHttpClient", () => {
  it("surfaces connection failures with context", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("DNS lookup failed");
    }) as unknown as FetchImplementation;

    await expect(Effect.runPromise(getJson(fetch))).rejects.toThrow(
      "Failed to establish a connection while fetching test config: DNS lookup failed",
    );
  });

  it("includes a compact response excerpt for invalid JSON", async () => {
    const fetch = vi.fn(
      async () => new Response("<html> sign in required </html>"),
    ) as unknown as FetchImplementation;

    await expect(Effect.runPromise(getJson(fetch))).rejects.toThrow(
      "returned invalid JSON. Response: <html> sign in required </html>",
    );
  });

  it("interrupts requests that exceed their timeout", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ) as unknown as FetchImplementation;

    await expect(Effect.runPromise(getJson(fetch, 5))).rejects.toThrow(
      "Fetching test config timed out",
    );
  });
});
