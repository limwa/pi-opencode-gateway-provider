import { Data } from "effect";

import { REAUTHENTICATE_MESSAGE } from "./constants.js";

export type GatewayErrorStage =
  | "host"
  | "discovery"
  | "authentication"
  | "configuration"
  | "catalog"
  | "request";

export class GatewayError extends Data.TaggedError("GatewayError")<{
  readonly stage: GatewayErrorStage;
  readonly message: string;
  readonly cause?: unknown;
  readonly status?: number;
}> {}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "An unknown error occurred";
}

export function forbiddenError(description: string): GatewayError {
  return new GatewayError({
    stage: "request",
    status: 403,
    message: `${description} rejected the request (HTTP 403). The authentication token may be expired or revoked. ${REAUTHENTICATE_MESSAGE}`,
  });
}
