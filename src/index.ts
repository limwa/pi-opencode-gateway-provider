import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, ManagedRuntime } from "effect";

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
): Promise<GatewayService["Service"]> {
  const runtime = ManagedRuntime.make(GatewayService.layer(options));
  const service = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* GatewayService;
    }),
  );

  pi.registerProvider(createGatewayProvider(runtime));

  pi.registerCommand("opencode-gateway-status", {
    description: `Inspect ${PROVIDER_NAME} authentication and models`,
    handler: async (_args, ctx) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const snapshot = yield* service.state.snapshot;
          const configured = yield* Effect.tryPromise(() =>
            ctx.modelRegistry.getProviderAuth(PROVIDER_ID),
          ).pipe(
            Effect.map((auth) => auth !== undefined),
            Effect.orElseSucceed(() => false),
          );
          const status = configured
            ? snapshot
            : { ...snapshot, phase: "not-configured" as const };

          yield* Effect.sync(() =>
            ctx.ui.notify(
              formatGatewayStatus(status),
              status.phase === "error" ? "error" : "info",
            ),
          );
        }),
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const status = yield* service.state.snapshot;
        const now = yield* service.now;
        const warning = expirationWarning(status, now);

        if (warning) {
          yield* Effect.sync(() => ctx.ui.notify(warning, "warning"));
        }
      }),
    );
  });

  pi.on("session_shutdown", () => runtime.dispose());

  return service;
}

export default async function openCodeGatewayExtension(
  pi: ExtensionAPI,
): Promise<void> {
  await registerOpenCodeGateway(pi);
}
