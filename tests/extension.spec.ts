import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerOpenCodeGateway } from "../src/index.js";

describe("extension registration", () => {
  it("registers the account provider, status command, and expiry hook", async () => {
    const registerProvider = vi.fn();
    const registerCommand = vi.fn();
    const on = vi.fn();
    const pi = {
      registerProvider,
      registerCommand,
      on,
    } as unknown as ExtensionAPI;

    await registerOpenCodeGateway(pi);

    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0]?.[0]).toMatchObject({
      id: "opencode-gateway",
      name: "OpenCode Gateway",
    });
    expect(registerCommand).toHaveBeenCalledWith(
      "opencode-gateway-status",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });
});
