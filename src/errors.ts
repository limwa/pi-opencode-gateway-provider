import { Predicate, Schema } from "effect";

import { REAUTHENTICATE_MESSAGE } from "./constants.js";

export type GatewayErrorStage =
  | "host"
  | "discovery"
  | "authentication"
  | "configuration"
  | "catalog"
  | "request";

export class GatewayError extends Schema.TaggedError<GatewayError>()(
  "GatewayError",
  {
    stage: Schema.Literals([
      "host",
      "discovery",
      "authentication",
      "configuration",
      "catalog",
      "request",
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
    status: Schema.optionalKey(Schema.Number),
  },
) {}

export function describeUnknownError(error: unknown): string {
  if (Predicate.isError(error) && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "An unknown error occurred";
}

export function describeSchemaError(error: Schema.SchemaError): string {
  return error.message.replace(/\s+/g, " ").trim().slice(0, 400);
}

export function forbiddenError(description: string): GatewayError {
  return new GatewayError({
    stage: "request",
    status: 403,
    message: `${description} rejected the request (HTTP 403). The authentication token may be expired or revoked. ${REAUTHENTICATE_MESSAGE}`,
  });
}
