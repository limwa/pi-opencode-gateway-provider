import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { substituteConfig } from "../src/substitution.js";

describe("OpenCode config substitution", () => {
  it("substitutes explicit environment values and JSON-escaped file contents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-gateway-config-"));

    try {
      await writeFile(path.join(root, "secret.txt"), ' value with "quotes"\n');

      const result = await Effect.runPromise(
        substituteConfig(
          {
            token: "{env:GATEWAY_TOKEN}",
            nested: { secret: "prefix:{file:secret.txt}:suffix" },
          },
          {
            env: { GATEWAY_TOKEN: "test-token" },
            source: path.join(root, "config.json"),
          },
        ),
      );

      expect(result).toEqual({
        token: "test-token",
        nested: { secret: 'prefix:value with "quotes":suffix' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unreadable file references with the resolved path", async () => {
    const source = path.join(os.tmpdir(), "gateway", ".well-known", "opencode");

    await expect(
      Effect.runPromise(
        substituteConfig({ secret: "{file:missing.txt}" }, { env: {}, source }),
      ),
    ).rejects.toThrow(
      `references {file:missing.txt}, but ${path.resolve(path.dirname(source), "missing.txt")} could not be read`,
    );
  });
});
