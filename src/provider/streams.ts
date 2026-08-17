import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type DeferredCancelOptions,
  type DeferredFetchOptions,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { Clock, Effect, Match } from "effect";

import { PROVIDER_ID, TOKEN_PLACEHOLDER } from "../constants.js";
import { describeUnknownError, forbiddenError } from "../errors.js";
import { GatewayService } from "../gateway-service.js";
import type { GatewayManagedRuntime } from "../provider.js";
import type { GatewayModel, GatewayModelMetadata } from "../types.js";

function metadataFor(model: Model<Api>): GatewayModelMetadata {
  const metadata = (model as Partial<GatewayModel>).opencodeGateway;
  if (metadata?.upstreamModelId) return metadata;

  const slash = model.id.indexOf("/");
  return {
    upstreamProviderId: slash > 0 ? model.id.slice(0, slash) : "unknown",
    upstreamModelId: slash > 0 ? model.id.slice(slash + 1) : model.id,
    npm: "unknown",
  };
}

function publicMessage(
  message: AssistantMessage,
  publicModelId: string,
): AssistantMessage {
  return {
    ...message,
    provider: PROVIDER_ID,
    model: publicModelId,
    ...(message.deferred
      ? {
          deferred: {
            ...message.deferred,
            modelId: publicModelId,
          },
        }
      : {}),
  };
}

function redact(value: string, token: string): string {
  return value.replaceAll(token, "[REDACTED]");
}

function recordForbidden(runtime: GatewayManagedRuntime) {
  const error = forbiddenError("OpenCode Gateway");

  runtime.runFork(
    GatewayService.use((service) => service.state.setError(error.message)),
  );
  return error;
}

function publicEvent(
  event: AssistantMessageEvent,
  publicModelId: string,
  token: string,
  runtime: GatewayManagedRuntime,
): AssistantMessageEvent {
  return Match.value(event).pipe(
    Match.when({ type: "done" }, (done) => ({
      ...done,
      message: publicMessage(done.message, publicModelId),
    })),
    Match.when({ type: "error" }, (failure) => {
      const error = publicMessage(failure.error, publicModelId);

      if (error.errorMessage) {
        error.errorMessage = redact(error.errorMessage, token);
      }
      if (/\b403\b/.test(error.errorMessage ?? "")) {
        error.errorMessage = recordForbidden(runtime).message;
      }

      return { ...failure, error };
    }),
    Match.when(Match.any, (update) => ({
      ...update,
      partial: publicMessage(update.partial, publicModelId),
    })),
    Match.exhaustive,
  );
}

function streamError(
  model: Model<Api>,
  cause: unknown,
  token: string,
  timestamp: number,
): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: PROVIDER_ID,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "error",
      errorMessage: `OpenCode Gateway stream failed: ${redact(describeUnknownError(cause), token)}`,
      timestamp,
    },
  };
}

function rewriteModelId(
  source: AssistantMessageEventStream,
  publicModel: Model<Api>,
  token: string,
  runtime: GatewayManagedRuntime,
): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();

  // Pi streams are async iterables, so this is the single Promise bridge for an
  // otherwise Effect-managed forwarding fiber.
  const forward = Effect.tryPromise({
    try: async () => {
      for await (const event of source) {
        target.push(publicEvent(event, publicModel.id, token, runtime));
      }
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        const timestamp = yield* Clock.currentTimeMillis;
        target.push(streamError(publicModel, cause, token, timestamp));
      }),
    ),
  );

  runtime.runFork(forward);
  return target;
}

function materializeToken<T>(value: T, token: string): T {
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") {
      return current.replaceAll(TOKEN_PLACEHOLDER, token);
    }
    if (Array.isArray(current)) return current.map(visit);
    if (typeof current !== "object" || current === null) return current;

    const prototype = Object.getPrototypeOf(current) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return current;

    return Object.fromEntries(
      Object.entries(current).map(([key, item]) => [key, visit(item)]),
    );
  };

  return visit(value) as T;
}

function requestOptions<T extends StreamOptions | undefined>(
  options: T,
  metadata: GatewayModelMetadata,
  token: string,
  runtime: GatewayManagedRuntime,
): T {
  const previous = options?.onResponse;
  const fetchImplementation = options?.fetch ?? globalThis.fetch;

  return materializeToken(
    {
      ...options,
      ...(options?.timeoutMs === undefined && metadata.timeoutMs !== undefined
        ? { timeoutMs: metadata.timeoutMs }
        : {}),
      onResponse: async (
        response: { status: number; headers: Record<string, string> },
        model: Model<Api>,
      ) => {
        await previous?.(response, model);
        if (response.status === 403) throw recordForbidden(runtime);
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetchImplementation(input, init);
        if (response.status === 403) recordForbidden(runtime);
        return response;
      },
    } as T,
    token,
  );
}

function requestModel(
  model: Model<Api>,
  metadata: GatewayModelMetadata,
  token: string,
): Model<Api> {
  return materializeToken(
    {
      ...model,
      id: metadata.upstreamModelId,
      provider: metadata.upstreamProviderId,
    },
    token,
  );
}

function requestContext(
  context: Context,
  metadata: GatewayModelMetadata,
): Context {
  const prefix = `${metadata.upstreamProviderId}/`;

  return {
    ...context,
    messages: context.messages.map((message) => {
      if (
        message.role !== "assistant" ||
        message.provider !== PROVIDER_ID ||
        !message.model.startsWith(prefix)
      ) {
        return message;
      }

      return {
        ...message,
        provider: metadata.upstreamProviderId,
        model: message.model.slice(prefix.length),
      };
    }),
  };
}

export function wrapStreams(
  streams: ProviderStreams,
  runtime: GatewayManagedRuntime,
): ProviderStreams {
  const token = () =>
    runtime.runSync(GatewayService.use((service) => service.activeToken));

  const wrapped: ProviderStreams = {
    stream(model, context, options) {
      const metadata = metadataFor(model);
      const activeToken = token();

      return rewriteModelId(
        streams.stream(
          requestModel(model, metadata, activeToken),
          requestContext(context, metadata),
          requestOptions(options, metadata, activeToken, runtime),
        ),
        model,
        activeToken,
        runtime,
      );
    },

    streamSimple(model, context, options) {
      const metadata = metadataFor(model);
      const activeToken = token();

      return rewriteModelId(
        streams.streamSimple(
          requestModel(model, metadata, activeToken),
          requestContext(context, metadata),
          requestOptions(
            options,
            metadata,
            activeToken,
            runtime,
          ) as SimpleStreamOptions,
        ),
        model,
        activeToken,
        runtime,
      );
    },
  };

  if (streams.fetchDeferred) {
    wrapped.fetchDeferred = (model, handle, options) => {
      const metadata = metadataFor(model);
      const activeToken = token();

      return rewriteModelId(
        streams.fetchDeferred!(
          requestModel(model, metadata, activeToken),
          { ...handle, modelId: metadata.upstreamModelId },
          requestOptions(
            options,
            metadata,
            activeToken,
            runtime,
          ) as DeferredFetchOptions,
        ),
        model,
        activeToken,
        runtime,
      );
    };
  }

  if (streams.cancelDeferred) {
    wrapped.cancelDeferred = (model, handle, options) => {
      const metadata = metadataFor(model);
      const activeToken = token();

      return streams.cancelDeferred!(
        requestModel(model, metadata, activeToken),
        { ...handle, modelId: metadata.upstreamModelId },
        requestOptions(
          options,
          metadata,
          activeToken,
          runtime,
        ) as DeferredCancelOptions,
      );
    };
  }

  return wrapped;
}
