import {
  NON_EXPIRING_TOKEN_TIMESTAMP,
  TOKEN_EXPIRY_WARNING_MS,
} from "./constants.js";

export interface TokenExpiration {
  expiresAt: number;
  kind: "jwt" | "opaque";
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  return Buffer.from(padded, "base64").toString("utf8");
}

export function tokenExpiration(token: string): TokenExpiration {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) {
    return { kind: "opaque", expiresAt: NON_EXPIRING_TOKEN_TIMESTAMP };
  }

  try {
    const payload = JSON.parse(decodeBase64Url(segments[1])) as unknown;
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("exp" in payload) ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp)
    ) {
      return { kind: "opaque", expiresAt: NON_EXPIRING_TOKEN_TIMESTAMP };
    }

    const expiresAt = payload.exp * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
      return { kind: "opaque", expiresAt: NON_EXPIRING_TOKEN_TIMESTAMP };
    }
    return { kind: "jwt", expiresAt };
  } catch {
    return { kind: "opaque", expiresAt: NON_EXPIRING_TOKEN_TIMESTAMP };
  }
}

export function isNearExpiration(expiresAt: number, now = Date.now()): boolean {
  return (
    expiresAt !== NON_EXPIRING_TOKEN_TIMESTAMP &&
    expiresAt - now <= TOKEN_EXPIRY_WARNING_MS
  );
}
