import {
  anthropicMessagesApi,
  createProvider,
  googleGenerativeAIApi,
  mistralConversationsApi,
  openAICompletionsApi,
  openAIResponsesApi,
  type Api,
  type Provider,
} from "@earendil-works/pi-ai/compat";
import { ManagedRuntime } from "effect";

import { PROVIDER_ID, PROVIDER_NAME } from "./constants.js";
import { GatewayService } from "./gateway-service.js";
import { wrapStreams } from "./provider/streams.js";

export type GatewayManagedRuntime = ManagedRuntime.ManagedRuntime<
  GatewayService,
  never
>;

export function createGatewayProvider(
  runtime: GatewayManagedRuntime,
): Provider<Api> {
  return createProvider({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    auth: {
      oauth: {
        name: PROVIDER_NAME,
        login: (interaction) =>
          runtime.runPromise(
            GatewayService.use((service) => service.login(interaction)),
            { signal: interaction.signal },
          ),
        refresh: (credential, signal) =>
          runtime.runPromise(
            GatewayService.use((service) => service.refresh(credential)),
            { signal },
          ),
        toAuth: (credential) =>
          runtime.runPromise(
            GatewayService.use((service) => service.toAuth(credential)),
          ),
      },
    },
    models: [],
    fetchModels: ({ credential, signal }) =>
      runtime.runPromise(
        GatewayService.use((service) =>
          service.fetchModels(
            credential?.type === "oauth" ? credential : undefined,
          ),
        ),
        { signal },
      ),
    api: {
      "anthropic-messages": wrapStreams(anthropicMessagesApi(), runtime),
      "openai-completions": wrapStreams(openAICompletionsApi(), runtime),
      "openai-responses": wrapStreams(openAIResponsesApi(), runtime),
      "google-generative-ai": wrapStreams(googleGenerativeAIApi(), runtime),
      "mistral-conversations": wrapStreams(mistralConversationsApi(), runtime),
    },
  });
}
