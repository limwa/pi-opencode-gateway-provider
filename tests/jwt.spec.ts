import { describe, expect, it } from "vitest";

import {
  NON_EXPIRING_TOKEN_TIMESTAMP,
  TOKEN_EXPIRY_WARNING_MS,
} from "../src/constants.js";
import { isNearExpiration, tokenExpiration } from "../src/jwt.js";
import { jwt } from "./helpers.js";

describe("token expiration", () => {
  it("records a JWT exp claim in milliseconds", () => {
    expect(tokenExpiration(jwt({ exp: 1_800_000_000 }))).toEqual({
      kind: "jwt",
      expiresAt: 1_800_000_000_000,
    });
  });

  it.each(["opaque-token", "a.not-json.c", jwt({ sub: "user" })])(
    "treats %j as non-expiring",
    (token) => {
      expect(tokenExpiration(token)).toEqual({
        kind: "opaque",
        expiresAt: NON_EXPIRING_TOKEN_TIMESTAMP,
      });
    },
  );

  it("warns only inside the expiry window", () => {
    const now = 1_000_000;
    expect(isNearExpiration(now + TOKEN_EXPIRY_WARNING_MS, now)).toBe(true);
    expect(isNearExpiration(now + TOKEN_EXPIRY_WARNING_MS + 1, now)).toBe(
      false,
    );
    expect(isNearExpiration(NON_EXPIRING_TOKEN_TIMESTAMP, now)).toBe(false);
  });
});
