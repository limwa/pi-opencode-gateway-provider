import { Option, pipe } from "effect";
import { decodeJwt } from "jose";

import {
  NON_EXPIRING_TOKEN_TIMESTAMP,
  TOKEN_EXPIRY_WARNING_MS,
} from "./constants.js";

export interface TokenExpiration {
  expiresAt: number;
  kind: "jwt" | "opaque";
}

const decodeToken = Option.liftThrowable(decodeJwt);

export function tokenExpiration(token: string): TokenExpiration {
  return pipe(
    decodeToken(token),
    Option.flatMap((payload) => {
      if (typeof payload.exp !== "number") return Option.none();

      const expiresAt = payload.exp * 1000;
      return Number.isSafeInteger(expiresAt) && expiresAt >= 0
        ? Option.some({ kind: "jwt" as const, expiresAt })
        : Option.none();
    }),
    Option.getOrElse(
      (): TokenExpiration => ({
        kind: "opaque",
        expiresAt: NON_EXPIRING_TOKEN_TIMESTAMP,
      }),
    ),
  );
}

export function isNearExpiration(expiresAt: number, now: number): boolean {
  return (
    expiresAt !== NON_EXPIRING_TOKEN_TIMESTAMP &&
    expiresAt - now <= TOKEN_EXPIRY_WARNING_MS
  );
}
