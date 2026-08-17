import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { loadOpenCodeConfig } from "../src/config.js";
import { TOKEN_PLACEHOLDER } from "../src/constants.js";
import { GatewayError } from "../src/errors.js";
import type { FetchImplementation, WellKnownDocument } from "../src/types.js";
import { jsonResponse } from "./helpers.js";

const metadata: WellKnownDocument = {
  auth: { command: ["authenticate"], env: "TOKEN" },
  config: {
    enabled_providers: ["anthropic", "openai"],
    provider: { anthropic: { options: { timeout: 10 } } },
  },
  remote_config: {
    url: "https://config.example/opencode.json",
    headers: { Authorization: "Bearer {env:TOKEN}" },
  },
};

describe("OpenCode config loading", () => {
  it("authenticates the remote fetch, deep-merges it, and redacts stored tokens", async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer secret-token",
        );
        return jsonResponse({
          config: {
            enabled_providers: ["anthropic"],
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
      },
    ) as unknown as FetchImplementation;

    const config = await Effect.runPromise(
      loadOpenCodeConfig(
        fetch,
        "https://gateway.example",
        metadata,
        "secret-token",
      ),
    );
    expect(config.enabled_providers).toEqual(["anthropic"]);
    expect(config.provider?.["anthropic"]?.options).toEqual({
      timeout: 10,
      baseURL: "https://gateway.example/anthropic",
      headers: { "cf-access-token": TOKEN_PLACEHOLDER },
    });
    expect(JSON.stringify(config)).not.toContain("secret-token");
  });

  it("turns a remote 403 into a reauthentication instruction", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        { error: "forbidden" },
        { status: 403, statusText: "Forbidden" },
      ),
    ) as unknown as FetchImplementation;
    await expect(
      Effect.runPromise(
        loadOpenCodeConfig(fetch, "https://gateway.example", metadata, "token"),
      ),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("/login") as unknown as string,
    });
  });

  it("rejects non-object remote config", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse([]),
    ) as unknown as FetchImplementation;
    await expect(
      Effect.runPromise(
        loadOpenCodeConfig(fetch, "https://gateway.example", metadata, "token"),
      ),
    ).rejects.toThrow("must be a JSON object");
  });

  it("redacts a token interpolated into the remote config URL from errors", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ error: "unavailable" }, { status: 500 }),
    ) as unknown as FetchImplementation;
    const operation = Effect.runPromise(
      loadOpenCodeConfig(
        fetch,
        "https://gateway.example",
        {
          ...metadata,
          remote_config: {
            url: "https://config.example/opencode.json?token={env:TOKEN}",
          },
        },
        "super-secret-token",
      ),
    );
    await expect(operation).rejects.toThrow("[REDACTED]");
    await expect(operation).rejects.not.toThrow("super-secret-token");
  });
});
