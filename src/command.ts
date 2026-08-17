import { Context, Effect, Layer } from "effect";
import { execa } from "execa";

import { MAX_COMMAND_OUTPUT_BYTES } from "./constants.js";
import { describeUnknownError, GatewayError } from "./errors.js";
import type { CommandRunner } from "./types.js";

function commandLabel(command: readonly string[]): string {
  return command
    .map((part) => (/^[\w./:=@+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

export const runAuthenticationCommand: CommandRunner = Effect.fn(
  "runAuthenticationCommand",
)(function* ({ command, onProgress }) {
  const executable = command[0];
  if (!executable?.trim()) {
    return yield* new GatewayError({
      stage: "authentication",
      message: "The gateway supplied an empty authentication command.",
    });
  }

  onProgress?.(`Running ${commandLabel(command)}`);

  const result = yield* Effect.tryPromise({
    try: (signal) =>
      execa(executable, command.slice(1), {
        cancelSignal: signal,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        reject: false,
        stdin: "ignore",
      }),
    catch: (cause) =>
      new GatewayError({
        stage: "authentication",
        cause,
        message: `The authentication command could not start: ${describeUnknownError(cause)}`,
      }),
  });

  if (result.isCanceled) {
    return yield* new GatewayError({
      stage: "authentication",
      message: "The authentication command was cancelled.",
    });
  }

  if (result.isMaxBuffer) {
    return yield* new GatewayError({
      stage: "authentication",
      message: "The authentication command produced too much output.",
    });
  }

  if (result.failed) {
    if (result.code === "ENOENT") {
      return yield* new GatewayError({
        stage: "authentication",
        cause: result,
        message: `The authentication command could not start because ${JSON.stringify(executable)} was not found. Install it and retry /login.`,
      });
    }

    const details = result.stderr.replace(/\s+/g, " ").trim().slice(0, 400);
    const outcome =
      result.exitCode === undefined
        ? ` after signal ${result.signal ?? "unknown"}`
        : ` with exit code ${result.exitCode}`;

    return yield* new GatewayError({
      stage: "authentication",
      cause: result,
      message: `The authentication command failed${outcome}.${details ? ` ${details}` : ""}`,
    });
  }

  const token = result.stdout.trim();
  if (!token) {
    return yield* new GatewayError({
      stage: "authentication",
      message:
        "The authentication command succeeded but returned an empty token.",
    });
  }

  return token;
});

export class AuthenticationCommand extends Context.Service<
  AuthenticationCommand,
  { readonly run: CommandRunner }
>()("pi-opencode-gateway-provider/AuthenticationCommand") {
  static readonly layer = Layer.succeed(
    AuthenticationCommand,
    AuthenticationCommand.of({ run: runAuthenticationCommand }),
  );

  static layerWith(run: CommandRunner) {
    return Layer.succeed(
      AuthenticationCommand,
      AuthenticationCommand.of({ run }),
    );
  }
}
