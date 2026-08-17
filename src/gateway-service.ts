import type {
  AuthResult,
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { Clock, Context, DateTime, Effect, Layer, Ref, Schema } from "effect";

import {
  DEFAULT_GATEWAY_HOST,
  PROVIDER_NAME,
  REAUTHENTICATE_MESSAGE,
} from "./constants.js";
import { resolveGatewayCatalog } from "./catalog.js";
import { AuthenticationCommand } from "./command.js";
import { loadModelsCatalog, loadOpenCodeConfig } from "./config.js";
import { discoverGateway, normalizeGatewayUrl } from "./discovery.js";
import { describeUnknownError, GatewayError } from "./errors.js";
import { GatewayHttpClient } from "./http.js";
import { isNearExpiration, tokenExpiration } from "./jwt.js";
import { GatewayRuntimeState } from "./runtime-state.js";
import { GatewayCredentialSchema } from "./schemas.js";
import type {
  CommandRunner,
  FetchImplementation,
  GatewayCredential,
  GatewayModel,
  ResolvedCatalog,
  WellKnownDocument,
} from "./types.js";

interface PreparedCatalog {
  readonly token: string;
  readonly catalog: ResolvedCatalog;
}

interface SessionData {
  readonly activeToken?: string;
  readonly prepared?: PreparedCatalog;
}

export interface GatewayServiceOptions {
  readonly fetch?: FetchImplementation;
  readonly commandRunner?: CommandRunner;
  readonly now?: () => number;
}

const isGatewayCredential = Schema.is(GatewayCredentialSchema);

export const GatewayNow = Context.Reference<Effect.Effect<number>>(
  "pi-opencode-gateway-provider/GatewayNow",
  { defaultValue: () => Clock.currentTimeMillis },
);

const promptForHost = Effect.fn("GatewayService.promptForHost")(
  (interaction: ProviderAuthInteraction) =>
    Effect.tryPromise({
      try: () =>
        interaction.prompt({
          type: "text",
          message: `OpenCode Gateway host (default: ${DEFAULT_GATEWAY_HOST})`,
          placeholder: DEFAULT_GATEWAY_HOST,
        }),
      catch: (cause) =>
        new GatewayError({
          stage: "host",
          cause,
          message: `Could not read the gateway host: ${describeUnknownError(cause)}`,
        }),
    }),
);

function notify(
  interaction: ProviderAuthInteraction,
  type: "progress" | "info",
  message: string,
) {
  return Effect.sync(() => interaction.notify({ type, message }));
}

function loginFailure(
  state: GatewayRuntimeState["Service"],
  cause: GatewayError,
) {
  return state.setError(cause.message).pipe(Effect.andThen(Effect.fail(cause)));
}

export class GatewayService extends Context.Service<
  GatewayService,
  {
    readonly state: GatewayRuntimeState["Service"];
    readonly now: Effect.Effect<number>;
    readonly activeToken: Effect.Effect<string, GatewayError>;
    login(
      interaction: ProviderAuthInteraction,
    ): Effect.Effect<GatewayCredential, GatewayError>;
    refresh(credential: OAuthCredential): Effect.Effect<never, GatewayError>;
    toAuth(
      credential: OAuthCredential,
    ): Effect.Effect<AuthResult["auth"], GatewayError>;
    fetchModels(
      credential: OAuthCredential | undefined,
    ): Effect.Effect<readonly GatewayModel[], GatewayError>;
  }
>()("pi-opencode-gateway-provider/GatewayService") {
  static readonly layerBase = Layer.effect(
    GatewayService,
    Effect.gen(function* () {
      const authentication = yield* AuthenticationCommand;
      const http = yield* GatewayHttpClient;
      const now = yield* GatewayNow;
      const state = yield* GatewayRuntimeState;
      const session = yield* Ref.make<SessionData>({});

      const load = Effect.fn("GatewayService.load")(function* (
        gatewayUrl: string,
        token: string,
        wellKnown: WellKnownDocument,
      ) {
        const [config, catalog] = yield* Effect.all(
          [
            loadOpenCodeConfig(gatewayUrl, wellKnown, token).pipe(
              Effect.provideService(GatewayHttpClient, http),
            ),
            loadModelsCatalog().pipe(
              Effect.provideService(GatewayHttpClient, http),
            ),
          ],
          { concurrency: "unbounded" },
        );

        return resolveGatewayCatalog(config, catalog);
      });

      const updateReady = Effect.fn("GatewayService.updateReady")(function* (
        credential: GatewayCredential,
        catalog: ResolvedCatalog,
      ) {
        const refreshedAt = yield* now;

        yield* state.update((status) => {
          const { lastError: _lastError, ...rest } = status;

          return {
            ...rest,
            phase: "ready",
            gatewayUrl: credential.gatewayUrl,
            tokenKind: credential.tokenKind,
            tokenExpiresAt: credential.expires,
            configuredAt: credential.issuedAt,
            lastRefreshAt: refreshedAt,
            modelCount: catalog.models.length,
            providerModelCounts: catalog.providerModelCounts,
            skippedModelCount: catalog.skippedModels.length,
            warnings: catalog.warnings,
          };
        });
      });

      const login = Effect.fn("GatewayService.login")(
        function* (interaction: ProviderAuthInteraction) {
          yield* state.update((status) => {
            const { lastError: _lastError, ...rest } = status;
            return { ...rest, phase: "authenticating" };
          });

          const host = yield* promptForHost(interaction);
          const gatewayUrl = yield* normalizeGatewayUrl(
            host || DEFAULT_GATEWAY_HOST,
          );

          yield* notify(
            interaction,
            "progress",
            `Loading gateway metadata from ${gatewayUrl}`,
          );
          const wellKnown = yield* discoverGateway(gatewayUrl).pipe(
            Effect.provideService(GatewayHttpClient, http),
          );
          const token = yield* authentication.run({
            command: wellKnown.auth.command,
            onProgress: (message) =>
              interaction.notify({ type: "progress", message }),
          });

          const expiration = tokenExpiration(token);
          const issuedAt = yield* now;
          if (expiration.expiresAt <= issuedAt) {
            return yield* new GatewayError({
              stage: "authentication",
              message: `The authentication command returned an already-expired JWT. ${REAUTHENTICATE_MESSAGE}`,
            });
          }

          yield* notify(
            interaction,
            "progress",
            "Fetching the OpenCode config and model catalog",
          );
          const catalog = yield* load(gatewayUrl, token, wellKnown);
          const credential: GatewayCredential = {
            type: "oauth",
            access: token,
            refresh: "",
            expires: expiration.expiresAt,
            gatewayUrl,
            tokenEnv: wellKnown.auth.env,
            issuedAt,
            tokenKind: expiration.kind,
          };

          yield* Ref.set(session, {
            activeToken: token,
            prepared: { token, catalog },
          });
          yield* updateReady(credential, catalog);

          if (isNearExpiration(credential.expires, issuedAt)) {
            yield* notify(
              interaction,
              "info",
              `Authentication succeeded, but the JWT expires soon (${DateTime.formatIso(DateTime.makeUnsafe(credential.expires))}). You will need to authenticate again via /login.`,
            );
          }

          return credential;
        },
        Effect.catch((cause) => loginFailure(state, cause)),
      );

      const refresh = Effect.fn("GatewayService.refresh")(function* (
        credential: OAuthCredential,
      ) {
        const gateway = isGatewayCredential(credential)
          ? credential.gatewayUrl
          : PROVIDER_NAME;
        const message = `${gateway} authentication has expired and cannot be refreshed non-interactively. ${REAUTHENTICATE_MESSAGE}`;

        yield* state.setError(message);
        return yield* new GatewayError({
          stage: "authentication",
          message,
        });
      });

      const toAuth = Effect.fn("GatewayService.toAuth")(function* (
        credential: OAuthCredential,
      ) {
        if (!isGatewayCredential(credential)) {
          return yield* new GatewayError({
            stage: "authentication",
            message: `Stored ${PROVIDER_NAME} credentials are incomplete. ${REAUTHENTICATE_MESSAGE}`,
          });
        }

        yield* Ref.update(session, (current) => ({
          ...current,
          activeToken: credential.access,
        }));
        yield* state.update((status) => ({
          ...status,
          gatewayUrl: credential.gatewayUrl,
          tokenKind: credential.tokenKind,
          tokenExpiresAt: credential.expires,
          configuredAt: credential.issuedAt,
        }));

        // Pi protocol adapters require an API key. Gateway workers discard this
        // placeholder header before forwarding the request upstream.
        return { apiKey: "opencode-gateway" };
      });

      const fetchModels = Effect.fn("GatewayService.fetchModels")(
        function* (credential: OAuthCredential | undefined) {
          if (!credential || !isGatewayCredential(credential)) return [];

          yield* Ref.update(session, (current) => ({
            ...current,
            activeToken: credential.access,
          }));

          const current = yield* Ref.get(session);
          const catalog =
            current.prepared?.token === credential.access
              ? current.prepared.catalog
              : yield* Effect.gen(function* () {
                  const wellKnown = yield* discoverGateway(
                    credential.gatewayUrl,
                  ).pipe(Effect.provideService(GatewayHttpClient, http));
                  return yield* load(
                    credential.gatewayUrl,
                    credential.access,
                    wellKnown,
                  );
                });

          yield* Ref.update(
            session,
            ({ prepared: _prepared, ...rest }) => rest,
          );
          yield* updateReady(credential, catalog);

          return catalog.models.map((entry) => entry.model);
        },
        Effect.catch((cause) => {
          const message =
            cause instanceof GatewayError
              ? cause.message
              : `Failed to refresh the OpenCode Gateway model catalog: ${describeUnknownError(cause)}`;
          const error =
            cause instanceof GatewayError
              ? cause
              : new GatewayError({ stage: "catalog", cause, message });

          return state
            .setError(message)
            .pipe(Effect.andThen(Effect.fail(error)));
        }),
      );

      const activeToken = Ref.get(session).pipe(
        Effect.flatMap((current) =>
          current.activeToken
            ? Effect.succeed(current.activeToken)
            : Effect.fail(
                new GatewayError({
                  stage: "authentication",
                  message: `The ${PROVIDER_NAME} token is unavailable. ${REAUTHENTICATE_MESSAGE}`,
                }),
              ),
        ),
      );

      return GatewayService.of({
        state,
        now,
        activeToken,
        login,
        refresh,
        toAuth,
        fetchModels,
      });
    }),
  );

  static layer(options: GatewayServiceOptions = {}) {
    const dependencies = Layer.mergeAll(
      GatewayRuntimeState.layer,
      GatewayHttpClient.layerWith(options.fetch ?? globalThis.fetch),
      options.commandRunner
        ? AuthenticationCommand.layerWith(options.commandRunner)
        : AuthenticationCommand.layer,
    );
    const service = this.layerBase.pipe(Layer.provide(dependencies));

    if (!options.now) return service;

    return service.pipe(
      Layer.provide(Layer.succeed(GatewayNow, Effect.sync(options.now))),
    );
  }
}
