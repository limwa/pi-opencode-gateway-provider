import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type DeferredCancelOptions,
  type DeferredFetchOptions,
  type DeferredHandle,
  type Model,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { Effect } from "effect";

import { PROVIDER_ID, PROVIDER_NAME } from "./constants.js";
import { describeUnknownError, forbiddenError } from "./errors.js";
import type { GatewayService } from "./gateway-service.js";
import type { GatewayModel, GatewayModelMetadata } from "./types.js";

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

function publicEvent(
  event: AssistantMessageEvent,
  publicModelId: string,
  service: GatewayService,
): AssistantMessageEvent {
  if (event.type === "done") {
    return { ...event, message: publicMessage(event.message, publicModelId) };
  }
  if (event.type === "error") {
    const error = publicMessage(event.error, publicModelId);
    if (error.errorMessage) {
      error.errorMessage = service.redactToken(error.errorMessage);
    }
    if (/\b403\b/.test(error.errorMessage ?? "")) {
      const forbidden = forbiddenError("OpenCode Gateway");
      Effect.runFork(service.state.setError(forbidden.message));
      error.errorMessage = forbidden.message;
    }
    return { ...event, error };
  }
  return {
    ...event,
    partial: publicMessage(event.partial, publicModelId),
  };
}

function rewriteModelId(
  source: AssistantMessageEventStream,
  publicModel: Model<Api>,
  service: GatewayService,
): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of source) {
        target.push(publicEvent(event, publicModel.id, service));
      }
    } catch (cause) {
      target.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: publicModel.api,
          provider: PROVIDER_ID,
          model: publicModel.id,
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
          errorMessage: `OpenCode Gateway stream failed: ${service.redactToken(describeUnknownError(cause))}`,
          timestamp: Date.now(),
        },
      });
    }
  })();
  return target;
}

function requestOptions<T extends StreamOptions | undefined>(
  options: T,
  metadata: GatewayModelMetadata,
  service: GatewayService,
): T {
  const previous = options?.onResponse;
  const fetchImplementation = options?.fetch ?? globalThis.fetch;
  const markForbidden = () => {
    const error = forbiddenError("OpenCode Gateway");
    Effect.runFork(service.state.setError(error.message));
    return error;
  };
  return service.materializeToken({
    ...options,
    ...(options?.timeoutMs === undefined && metadata.timeoutMs !== undefined
      ? { timeoutMs: metadata.timeoutMs }
      : {}),
    onResponse: async (
      response: { status: number; headers: Record<string, string> },
      model: Model<Api>,
    ) => {
      await previous?.(response, model);
      if (response.status === 403) throw markForbidden();
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetchImplementation(input, init);
      if (response.status === 403) markForbidden();
      return response;
    },
  } as T);
}

function requestModel(
  model: Model<Api>,
  metadata: GatewayModelMetadata,
  service: GatewayService,
): Model<Api> {
  return service.materializeToken({
    ...model,
    id: metadata.upstreamModelId,
    provider: metadata.upstreamProviderId,
  });
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

function wrapStreams(
  streams: ProviderStreams,
  service: GatewayService,
): ProviderStreams {
  const wrapped: ProviderStreams = {
    stream(model, context, options) {
      const metadata = metadataFor(model);
      return rewriteModelId(
        streams.stream(
          requestModel(model, metadata, service),
          requestContext(context, metadata),
          requestOptions(options, metadata, service),
        ),
        model,
        service,
      );
    },
    streamSimple(model, context, options) {
      const metadata = metadataFor(model);
      return rewriteModelId(
        streams.streamSimple(
          requestModel(model, metadata, service),
          requestContext(context, metadata),
          requestOptions(options, metadata, service) as SimpleStreamOptions,
        ),
        model,
        service,
      );
    },
  };
  if (streams.fetchDeferred) {
    wrapped.fetchDeferred = (
      model: Model<Api>,
      handle: DeferredHandle,
      options?: DeferredFetchOptions,
    ) => {
      const metadata = metadataFor(model);
      return rewriteModelId(
        streams.fetchDeferred!(
          requestModel(model, metadata, service),
          { ...handle, modelId: metadata.upstreamModelId },
          requestOptions(options, metadata, service) as DeferredFetchOptions,
        ),
        model,
        service,
      );
    };
  }
  if (streams.cancelDeferred) {
    wrapped.cancelDeferred = (
      model: Model<Api>,
      handle: DeferredHandle,
      options?: DeferredCancelOptions,
    ) => {
      const metadata = metadataFor(model);
      return streams.cancelDeferred!(
        requestModel(model, metadata, service),
        { ...handle, modelId: metadata.upstreamModelId },
        requestOptions(options, metadata, service) as DeferredCancelOptions,
      );
    };
  }
  return wrapped;
}

export function createGatewayProvider(service: GatewayService): Provider<Api> {
  return createProvider({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    auth: {
      oauth: {
        name: PROVIDER_NAME,
        login: (interaction) => service.login(interaction),
        refresh: (credential, signal) => service.refresh(credential, signal),
        toAuth: (credential) => service.toAuth(credential),
      },
    },
    models: [],
    fetchModels: ({ credential, signal }) =>
      service.fetchModels(
        credential?.type === "oauth" ? credential : undefined,
        signal,
      ),
    api: {
      "anthropic-messages": wrapStreams(anthropicMessagesApi(), service),
      "openai-completions": wrapStreams(openAICompletionsApi(), service),
      "openai-responses": wrapStreams(openAIResponsesApi(), service),
      "google-generative-ai": wrapStreams(googleGenerativeAIApi(), service),
      "mistral-conversations": wrapStreams(mistralConversationsApi(), service),
    },
  });
}
