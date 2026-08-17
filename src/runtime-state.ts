import { Context, Effect, Layer, Ref } from "effect";

import type { GatewayStatus } from "./types.js";

function initialStatus(): GatewayStatus {
  return {
    phase: "not-configured",
    modelCount: 0,
    providerModelCounts: {},
    skippedModelCount: 0,
    warnings: [],
  };
}

export class GatewayRuntimeState extends Context.Service<
  GatewayRuntimeState,
  {
    readonly snapshot: Effect.Effect<GatewayStatus>;
    update(
      transform: (status: GatewayStatus) => GatewayStatus,
    ): Effect.Effect<void>;
    setError(message: string): Effect.Effect<void>;
  }
>()("pi-opencode-gateway-provider/GatewayRuntimeState") {
  static readonly layer = Layer.effect(
    GatewayRuntimeState,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initialStatus());

      const snapshot = Ref.get(ref).pipe(
        Effect.map((status) => structuredClone(status)),
      );
      const update = Effect.fn("GatewayRuntimeState.update")(
        (transform: (status: GatewayStatus) => GatewayStatus) =>
          Ref.update(ref, (status) => transform(structuredClone(status))),
      );
      const setError = Effect.fn("GatewayRuntimeState.setError")(
        (message: string) =>
          update((status) => ({
            ...status,
            phase: "error",
            lastError: message,
          })),
      );

      return GatewayRuntimeState.of({ snapshot, update, setError });
    }),
  );
}
