import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { parseWellKnown, normalizeGatewayUrl } from "../src/discovery.js";
import { GatewayError } from "../src/errors.js";

describe("gateway discovery", () => {
  it.each([
    ["opencode.cloudflare.dev", "https://opencode.cloudflare.dev"],
    ["https://example.com/", "https://example.com"],
    ["http://localhost:8787/base/", "http://localhost:8787/base"],
  ])("normalizes %s", (input, expected) => {
    expect(Effect.runSync(normalizeGatewayUrl(input))).toBe(expected);
  });

  it.each(["", "ftp://example.com", "https://user:pass@example.com"])(
    "rejects invalid gateway input %j",
    (input) => {
      expect(() => Effect.runSync(normalizeGatewayUrl(input))).toThrow(
        GatewayError,
      );
    },
  );

  it("parses embedded and remote config metadata", () => {
    expect(
      Effect.runSync(
        parseWellKnown(
          {
            auth: {
              command: ["cloudflared", "access", "login"],
              env: "TOKEN",
            },
            config: { enabled_providers: ["anthropic"] },
            remote_config: {
              url: "https://example.com/config.json",
              headers: { "cf-access-token": "{env:TOKEN}" },
            },
          },
          "https://example.com/.well-known/opencode",
        ),
      ),
    ).toEqual({
      auth: { command: ["cloudflared", "access", "login"], env: "TOKEN" },
      config: { enabled_providers: ["anthropic"] },
      remote_config: {
        url: "https://example.com/config.json",
        headers: { "cf-access-token": "{env:TOKEN}" },
      },
    });
  });

  it.each([
    {},
    { auth: {} },
    { auth: { command: [], env: "TOKEN" } },
    { auth: { command: ["login"], env: "" } },
    { auth: { command: ["login"], env: " " } },
    { auth: { command: ["login"], env: "TOKEN" }, remote_config: [] },
  ])("rejects malformed metadata", (value) => {
    expect(() =>
      Effect.runSync(parseWellKnown(value, "https://example.com")),
    ).toThrow(GatewayError);
  });
});
