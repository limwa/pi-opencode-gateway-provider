import { describe, expect, it } from "vitest";

import { runAuthenticationCommand } from "../src/command.js";

describe("authentication command", () => {
  it("captures and trims stdout without invoking a shell", async () => {
    await expect(
      runAuthenticationCommand({
        command: [process.execPath, "-e", "process.stdout.write(' token\\n')"],
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("token");
  });

  it("surfaces a non-zero exit and stderr", async () => {
    await expect(
      runAuthenticationCommand({
        command: [
          process.execPath,
          "-e",
          "process.stderr.write('SSO denied'); process.exit(7)",
        ],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("exit code 7. SSO denied");
  });

  it("reports a missing executable", async () => {
    await expect(
      runAuthenticationCommand({
        command: ["definitely-not-a-real-opencode-auth-command"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("was not found");
  });
});
