import { spawn } from "node:child_process";

import { MAX_COMMAND_OUTPUT_BYTES } from "./constants.js";
import { describeUnknownError, GatewayError } from "./errors.js";
import type { CommandRunner } from "./types.js";

function commandLabel(command: readonly string[]): string {
  return command
    .map((part) => (/^[\w./:=@+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

export const runAuthenticationCommand: CommandRunner = ({
  command,
  signal,
  onProgress,
}) =>
  new Promise((resolve, reject) => {
    if (command.length === 0 || !command[0]?.trim()) {
      reject(
        new GatewayError({
          stage: "authentication",
          message: "The gateway supplied an empty authentication command.",
        }),
      );
      return;
    }

    onProgress?.(`Running ${commandLabel(command)}`);
    const child = spawn(command[0], command.slice(1), {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(() =>
        reject(
          new GatewayError({
            stage: "authentication",
            message: "The authentication command was cancelled.",
          }),
        ),
      );
    };

    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(() =>
          reject(
            new GatewayError({
              stage: "authentication",
              message: "The authentication command produced too much output.",
            }),
          ),
        );
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_192);
    });
    child.on("error", (cause: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new GatewayError({
            stage: "authentication",
            cause,
            message:
              cause.code === "ENOENT"
                ? `The authentication command could not start because ${JSON.stringify(command[0])} was not found. Install it and retry /login.`
                : `The authentication command could not start: ${describeUnknownError(cause)}`,
          }),
        ),
      );
    });
    child.on("close", (code, childSignal) => {
      finish(() => {
        if (code !== 0) {
          const details = stderr.replace(/\s+/g, " ").trim().slice(0, 400);
          reject(
            new GatewayError({
              stage: "authentication",
              message: `The authentication command failed${code === null ? ` after signal ${childSignal ?? "unknown"}` : ` with exit code ${code}`}.${details ? ` ${details}` : ""}`,
            }),
          );
          return;
        }
        const token = stdout.trim();
        if (!token) {
          reject(
            new GatewayError({
              stage: "authentication",
              message:
                "The authentication command succeeded but returned an empty token.",
            }),
          );
          return;
        }
        resolve(token);
      });
    });
  });
