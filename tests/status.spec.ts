import { describe, expect, it } from "vitest";

import { NON_EXPIRING_TOKEN_TIMESTAMP } from "../src/constants.js";
import { expirationWarning, formatGatewayStatus } from "../src/status.js";
import type { GatewayStatus } from "../src/types.js";

const ready: GatewayStatus = {
  phase: "ready",
  gatewayUrl: "https://gateway.example",
  tokenKind: "opaque",
  tokenExpiresAt: NON_EXPIRING_TOKEN_TIMESTAMP,
  modelCount: 3,
  providerModelCounts: { anthropic: 2, openai: 1 },
  skippedModelCount: 1,
  warnings: ["One warning"],
  lastRefreshAt: Date.parse("2026-08-17T00:00:00Z"),
};

describe("gateway status", () => {
  it("renders useful status without exposing credentials", () => {
    const output = formatGatewayStatus(ready);
    expect(output).toContain("OpenCode Gateway: ready");
    expect(output).toContain("opaque (no expiration claim");
    expect(output).toContain("anthropic (2), openai (1)");
    expect(output).toContain("Skipped models: 1");
  });

  it("instructs unauthenticated users to login", () => {
    expect(
      formatGatewayStatus({
        phase: "not-configured",
        modelCount: 0,
        providerModelCounts: {},
        skippedModelCount: 0,
        warnings: [],
      }),
    ).toContain("/login");
  });

  it("warns near JWT expiration", () => {
    const now = Date.parse("2026-08-17T00:00:00Z");
    expect(
      expirationWarning(
        {
          ...ready,
          tokenKind: "jwt",
          tokenExpiresAt: now + 60_000,
        },
        now,
      ),
    ).toContain("expires soon");
  });
});
