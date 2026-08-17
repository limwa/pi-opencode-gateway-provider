import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { runAuthenticationCommand } from "../src/command.js";

describe("authentication command", () => {
  it("captures and trims stdout without invoking a shell", async () => {
    await expect(
      Effect.runPromise(
        runAuthenticationCommand({
          command: [
            process.execPath,
            "-e",
            "process.stdout.write(' token\\n')",
          ],
        }),
      ),
    ).resolves.toBe("token");
  });

  it("surfaces a non-zero exit and stderr", async () => {
    await expect(
      Effect.runPromise(
        runAuthenticationCommand({
          command: [
            process.execPath,
            "-e",
            "process.stderr.write('SSO denied'); process.exit(7)",
          ],
        }),
      ),
    ).rejects.toThrow("exit code 7. SSO denied");
  });

  it("reports a missing executable", async () => {
    await expect(
      Effect.runPromise(
        runAuthenticationCommand({
          command: ["definitely-not-a-real-opencode-auth-command"],
        }),
      ),
    ).rejects.toThrow("was not found");
  });
});
