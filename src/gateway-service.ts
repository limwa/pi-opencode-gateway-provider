import type {
  AuthResult,
  Model,
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { Effect } from "effect";

import {
  DEFAULT_GATEWAY_HOST,
  NON_EXPIRING_TOKEN_TIMESTAMP,
  PROVIDER_NAME,
  REAUTHENTICATE_MESSAGE,
  TOKEN_PLACEHOLDER,
} from "./constants.js";
import { resolveGatewayCatalog } from "./catalog.js";
import { runAuthenticationCommand } from "./command.js";
import { loadModelsCatalog, loadOpenCodeConfig } from "./config.js";
import { discoverGateway, normalizeGatewayUrl } from "./discovery.js";
import { describeUnknownError, GatewayError } from "./errors.js";
import { isNearExpiration, tokenExpiration } from "./jwt.js";
import { GatewayRuntimeState } from "./runtime-state.js";
import type {
  CommandRunner,
  FetchImplementation,
  GatewayCredential,
  GatewayModel,
  ResolvedCatalog,
  WellKnownDocument,
} from "./types.js";

interface PreparedCatalog {
  token: string;
  catalog: ResolvedCatalog;
}

export interface GatewayServiceOptions {
  fetch?: FetchImplementation;
  commandRunner?: CommandRunner;
  now?: () => number;
}

function isGatewayCredential(
  credential: OAuthCredential,
): credential is GatewayCredential {
  return (
    typeof credential["gatewayUrl"] === "string" &&
    typeof credential["tokenEnv"] === "string" &&
    typeof credential["issuedAt"] === "number" &&
    (credential["tokenKind"] === "jwt" || credential["tokenKind"] === "opaque")
  );
}

export class GatewayService {
  private prepared: PreparedCatalog | undefined;
  private activeToken: string | undefined;

  private constructor(
    readonly state: GatewayRuntimeState,
    private readonly fetchImplementation: FetchImplementation,
    private readonly commandRunner: CommandRunner,
    private readonly now: () => number,
  ) {}

  static make(
    options: GatewayServiceOptions = {},
  ): Effect.Effect<GatewayService> {
    return Effect.map(
      GatewayRuntimeState.make(),
      (state) =>
        new GatewayService(
          state,
          options.fetch ?? globalThis.fetch,
          options.commandRunner ?? runAuthenticationCommand,
          options.now ?? Date.now,
        ),
    );
  }

  private load(
    gatewayUrl: string,
    token: string,
    wellKnown: WellKnownDocument,
    signal: AbortSignal,
  ): Effect.Effect<ResolvedCatalog, GatewayError> {
    const self = this;
    return Effect.gen(function* () {
      const [config, catalog] = yield* Effect.all(
        [
          loadOpenCodeConfig(
            self.fetchImplementation,
            gatewayUrl,
            wellKnown,
            token,
            signal,
          ),
          loadModelsCatalog(self.fetchImplementation, signal),
        ],
        { concurrency: "unbounded" },
      );
      return resolveGatewayCatalog(config, catalog);
    });
  }

  private updateReady(
    credential: GatewayCredential,
    catalog: ResolvedCatalog,
  ): Effect.Effect<void> {
    return this.state.update((status) => {
      const { lastError: _lastError, ...rest } = status;
      return {
        ...rest,
        phase: "ready",
        gatewayUrl: credential.gatewayUrl,
        tokenKind: credential.tokenKind,
        tokenExpiresAt: credential.expires,
        configuredAt: credential.issuedAt,
        lastRefreshAt: this.now(),
        modelCount: catalog.models.length,
        providerModelCounts: catalog.providerModelCounts,
        skippedModelCount: catalog.skippedModels.length,
        warnings: catalog.warnings,
      };
    });
  }

  async login(
    interaction: ProviderAuthInteraction,
  ): Promise<GatewayCredential> {
    await Effect.runPromise(
      this.state.update((status) => {
        const { lastError: _lastError, ...rest } = status;
        return { ...rest, phase: "authenticating" };
      }),
    );

    try {
      const host = await interaction.prompt({
        type: "text",
        message: `OpenCode Gateway host (default: ${DEFAULT_GATEWAY_HOST})`,
        placeholder: DEFAULT_GATEWAY_HOST,
      });
      const gatewayUrl = normalizeGatewayUrl(host || DEFAULT_GATEWAY_HOST);
      interaction.notify({
        type: "progress",
        message: `Loading gateway metadata from ${gatewayUrl}`,
      });
      const wellKnown = await Effect.runPromise(
        discoverGateway(
          this.fetchImplementation,
          gatewayUrl,
          interaction.signal,
        ),
      );
      const token = await this.commandRunner({
        command: wellKnown.auth.command,
        signal: interaction.signal,
        onProgress: (message) =>
          interaction.notify({ type: "progress", message }),
      });
      const expiration = tokenExpiration(token);
      const now = this.now();
      if (expiration.expiresAt <= now) {
        throw new GatewayError({
          stage: "authentication",
          message: `The authentication command returned an already-expired JWT. ${REAUTHENTICATE_MESSAGE}`,
        });
      }

      interaction.notify({
        type: "progress",
        message: "Fetching the OpenCode config and model catalog",
      });
      const catalog = await Effect.runPromise(
        this.load(gatewayUrl, token, wellKnown, interaction.signal),
      );
      const credential: GatewayCredential = {
        type: "oauth",
        access: token,
        refresh: "",
        expires: expiration.expiresAt,
        gatewayUrl,
        tokenEnv: wellKnown.auth.env,
        issuedAt: now,
        tokenKind: expiration.kind,
      };
      this.activeToken = token;
      this.prepared = { token, catalog };
      await Effect.runPromise(this.updateReady(credential, catalog));

      if (isNearExpiration(credential.expires, now)) {
        interaction.notify({
          type: "info",
          message: `Authentication succeeded, but the JWT expires soon (${new Date(credential.expires).toISOString()}). You will need to authenticate again via /login.`,
        });
      }
      return credential;
    } catch (cause) {
      const message =
        cause instanceof GatewayError
          ? cause.message
          : `OpenCode Gateway login failed: ${describeUnknownError(cause)}`;
      await Effect.runPromise(this.state.setError(message));
      if (cause instanceof Error) throw cause;
      throw new GatewayError({
        stage: "authentication",
        cause,
        message,
      });
    }
  }

  async refresh(
    credential: OAuthCredential,
    _signal: AbortSignal,
  ): Promise<GatewayCredential> {
    const gateway = isGatewayCredential(credential)
      ? credential.gatewayUrl
      : PROVIDER_NAME;
    const message = `${gateway} authentication has expired and cannot be refreshed non-interactively. ${REAUTHENTICATE_MESSAGE}`;
    await Effect.runPromise(this.state.setError(message));
    throw new GatewayError({ stage: "authentication", message });
  }

  async toAuth(credential: OAuthCredential): Promise<AuthResult["auth"]> {
    if (!isGatewayCredential(credential)) {
      throw new GatewayError({
        stage: "authentication",
        message: `Stored ${PROVIDER_NAME} credentials are incomplete. ${REAUTHENTICATE_MESSAGE}`,
      });
    }
    this.activeToken = credential.access;
    await Effect.runPromise(
      this.state.update((status) => ({
        ...status,
        gatewayUrl: credential.gatewayUrl,
        tokenKind: credential.tokenKind,
        tokenExpiresAt: credential.expires,
        configuredAt: credential.issuedAt,
      })),
    );
    // Pi's protocol adapters require an API key even when a gateway authenticates
    // with custom model headers. Gateway workers discard the placeholder's
    // standard Authorization/x-api-key header before forwarding upstream.
    return { apiKey: "opencode-gateway" };
  }

  async fetchModels(
    credential: OAuthCredential | undefined,
    signal: AbortSignal,
  ): Promise<readonly GatewayModel[]> {
    if (!credential || !isGatewayCredential(credential)) return [];
    this.activeToken = credential.access;

    try {
      let catalog: ResolvedCatalog;
      if (this.prepared?.token === credential.access) {
        catalog = this.prepared.catalog;
        this.prepared = undefined;
      } else {
        const wellKnown = await Effect.runPromise(
          discoverGateway(
            this.fetchImplementation,
            credential.gatewayUrl,
            signal,
          ),
        );
        catalog = await Effect.runPromise(
          this.load(
            credential.gatewayUrl,
            credential.access,
            wellKnown,
            signal,
          ),
        );
      }
      await Effect.runPromise(this.updateReady(credential, catalog));
      return catalog.models.map((entry) => entry.model);
    } catch (cause) {
      const message =
        cause instanceof GatewayError
          ? cause.message
          : `Failed to refresh the OpenCode Gateway model catalog: ${describeUnknownError(cause)}`;
      await Effect.runPromise(this.state.setError(message));
      if (cause instanceof Error) throw cause;
      throw new GatewayError({ stage: "catalog", cause, message });
    }
  }

  tokenIsNonExpiring(credential: OAuthCredential): boolean {
    return credential.expires === NON_EXPIRING_TOKEN_TIMESTAMP;
  }

  materializeToken<T>(value: T): T {
    const token = this.activeToken;
    const visit = (current: unknown): unknown => {
      if (typeof current === "string") {
        if (!current.includes(TOKEN_PLACEHOLDER)) return current;
        if (!token) {
          throw new GatewayError({
            stage: "authentication",
            message: `The ${PROVIDER_NAME} token is unavailable. ${REAUTHENTICATE_MESSAGE}`,
          });
        }
        return current.replaceAll(TOKEN_PLACEHOLDER, token);
      }
      if (Array.isArray(current)) return current.map(visit);
      if (typeof current === "object" && current !== null) {
        const prototype = Object.getPrototypeOf(current) as unknown;
        if (prototype !== Object.prototype && prototype !== null)
          return current;
        return Object.fromEntries(
          Object.entries(current).map(([key, item]) => [key, visit(item)]),
        );
      }
      return current;
    };
    return visit(value) as T;
  }

  redactToken(value: string): string {
    return this.activeToken
      ? value.replaceAll(this.activeToken, "[REDACTED]")
      : value;
  }
}
