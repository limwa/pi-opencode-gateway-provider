import { Effect, Ref } from "effect";

import type { GatewayStatus } from "./types.js";

const initialStatus = (): GatewayStatus => ({
  phase: "not-configured",
  modelCount: 0,
  providerModelCounts: {},
  skippedModelCount: 0,
  warnings: [],
});

export class GatewayRuntimeState {
  private constructor(private readonly ref: Ref.Ref<GatewayStatus>) {}

  static make(): Effect.Effect<GatewayRuntimeState> {
    return Effect.map(
      Ref.make(initialStatus()),
      (ref) => new GatewayRuntimeState(ref),
    );
  }

  snapshot(): Effect.Effect<GatewayStatus> {
    return Effect.map(Ref.get(this.ref), (status) => structuredClone(status));
  }

  update(
    update: (status: GatewayStatus) => GatewayStatus,
  ): Effect.Effect<void> {
    return Ref.update(this.ref, (status) => update(structuredClone(status)));
  }

  setError(message: string): Effect.Effect<void> {
    return this.update((status) => ({
      ...status,
      phase: "error",
      lastError: message,
    }));
  }
}
