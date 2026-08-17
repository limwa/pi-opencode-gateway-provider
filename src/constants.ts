export const PROVIDER_ID = "opencode-gateway";
export const PROVIDER_NAME = "OpenCode Gateway";
export const DEFAULT_GATEWAY_HOST = "gateway.example.com";
export const WELL_KNOWN_PATH = "/.well-known/opencode";
export const MODELS_CATALOG_URL = "https://models.opencode.ai/api.json";
export const REQUEST_TIMEOUT_MS = 15_000;
export const TOKEN_EXPIRY_WARNING_MS = 15 * 60 * 1000;
export const NON_EXPIRING_TOKEN_TIMESTAMP = Number.MAX_SAFE_INTEGER;
export const MAX_HTTP_BODY_BYTES = 20 * 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
export const TOKEN_PLACEHOLDER = "__PI_OPENCODE_GATEWAY_AUTH_TOKEN__";

export const REAUTHENTICATE_MESSAGE =
  "Reauthenticate with /login and choose OpenCode Gateway.";
