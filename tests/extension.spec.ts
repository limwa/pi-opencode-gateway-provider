import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { registerOpenCodeGateway } from "../src/index.js";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

describe("extension registration", () => {
  it("loads through Pi's extension module aliases", async () => {
    const extensionPath = fileURLToPath(
      new URL("../src/index.ts", import.meta.url),
    );
    const result = await loadExtensions([extensionPath], process.cwd());

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);

    const shutdown =
      result.extensions[0]?.handlers.get("session_shutdown")?.[0];
    await shutdown?.({}, {} as never);
  });

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
    expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));

    const shutdown = on.mock.calls.find(
      ([event]) => event === "session_shutdown",
    )?.[1] as (() => Promise<void>) | undefined;
    await shutdown?.();
  });
});
