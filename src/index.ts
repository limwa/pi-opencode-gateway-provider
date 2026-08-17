import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { PROVIDER_ID, PROVIDER_NAME } from "./constants.js";
import {
  GatewayService,
  type GatewayServiceOptions,
} from "./gateway-service.js";
import { createGatewayProvider } from "./provider.js";
import { expirationWarning, formatGatewayStatus } from "./status.js";

export { GatewayService } from "./gateway-service.js";
export { createGatewayProvider } from "./provider.js";
export { resolveGatewayCatalog } from "./catalog.js";
export { normalizeGatewayUrl, parseWellKnown } from "./discovery.js";
export { tokenExpiration } from "./jwt.js";

export async function registerOpenCodeGateway(
  pi: ExtensionAPI,
  options: GatewayServiceOptions = {},
): Promise<GatewayService> {
  const service = await Effect.runPromise(GatewayService.make(options));
  pi.registerProvider(createGatewayProvider(service));

  pi.registerCommand("opencode-gateway-status", {
    description: `Inspect ${PROVIDER_NAME} authentication and models`,
    handler: async (_args, ctx) => {
      const snapshot = await Effect.runPromise(service.state.snapshot());
      const configured = await ctx.modelRegistry
        .getProviderAuth(PROVIDER_ID)
        .then((auth) => auth !== undefined)
        .catch(() => false);
      const status = configured
        ? snapshot
        : { ...snapshot, phase: "not-configured" as const };
      ctx.ui.notify(
        formatGatewayStatus(status),
        status.phase === "error" ? "error" : "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const status = await Effect.runPromise(service.state.snapshot());
    const warning = expirationWarning(status);
    if (warning) ctx.ui.notify(warning, "warning");
  });

  return service;
}

export default async function openCodeGatewayExtension(
  pi: ExtensionAPI,
): Promise<void> {
  await registerOpenCodeGateway(pi);
}
