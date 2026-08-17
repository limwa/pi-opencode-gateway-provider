import { DateTime } from "effect";

import {
  NON_EXPIRING_TOKEN_TIMESTAMP,
  PROVIDER_NAME,
  REAUTHENTICATE_MESSAGE,
} from "./constants.js";
import { isNearExpiration } from "./jwt.js";
import type { GatewayStatus } from "./types.js";

function timestamp(value: number): string {
  return DateTime.makeUnsafe(value).pipe(DateTime.formatIso);
}

export function expirationWarning(
  status: GatewayStatus,
  now: number,
): string | undefined {
  if (
    status.tokenExpiresAt === undefined ||
    !isNearExpiration(status.tokenExpiresAt, now)
  ) {
    return undefined;
  }
  if (status.tokenExpiresAt <= now) {
    return `${PROVIDER_NAME} authentication expired at ${timestamp(status.tokenExpiresAt)}. ${REAUTHENTICATE_MESSAGE}`;
  }
  return `${PROVIDER_NAME} authentication expires soon (${timestamp(status.tokenExpiresAt)}). ${REAUTHENTICATE_MESSAGE}`;
}

export function formatGatewayStatus(status: GatewayStatus): string {
  const lines = [`${PROVIDER_NAME}: ${status.phase}`];
  if (status.gatewayUrl) lines.push(`Gateway: ${status.gatewayUrl}`);
  if (status.tokenKind) {
    lines.push(
      status.tokenExpiresAt === NON_EXPIRING_TOKEN_TIMESTAMP
        ? "Token: opaque (no expiration claim; treated as non-expiring)"
        : status.tokenExpiresAt === undefined
          ? `Token: ${status.tokenKind} (expiration unavailable)`
          : `Token: ${status.tokenKind}, expires ${timestamp(status.tokenExpiresAt)}`,
    );
  }
  lines.push(`Models: ${status.modelCount}`);
  const providers = Object.entries(status.providerModelCounts);
  if (providers.length > 0) {
    lines.push(
      `Upstream providers: ${providers.map(([id, count]) => `${id} (${count})`).join(", ")}`,
    );
  }
  if (status.skippedModelCount > 0) {
    lines.push(`Skipped models: ${status.skippedModelCount}`);
  }
  if (status.lastRefreshAt) {
    lines.push(`Last catalog refresh: ${timestamp(status.lastRefreshAt)}`);
  }
  for (const warning of status.warnings) lines.push(`Warning: ${warning}`);
  if (status.lastError) lines.push(`Last error: ${status.lastError}`);
  if (status.phase === "not-configured" || status.phase === "error") {
    lines.push(REAUTHENTICATE_MESSAGE);
  }
  return lines.join("\n");
}
