import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { resolveGatewayCatalog } from "../src/catalog.js";
import type {
  ModelsCatalog,
  OpenCodeConfig,
  ResolvedCatalog,
} from "../src/types.js";

const OPENCODE_VERSION = "1.18.18";
const MODELS_URL = "https://models.opencode.ai/api.json";
const PROVIDERS = [
  "alibaba",
  "anthropic",
  "baseten",
  "cerebras",
  "cloudflare-workers-ai",
  "deepinfra",
  "fireworks-ai",
  "google",
  "groq",
  "huggingface",
  "mistral",
  "nvidia",
  "openai",
  "openrouter",
  "perplexity",
  "togetherai",
  "xai",
] as const;

const temporaryRoots: string[] = [];

interface OracleModel {
  id: string;
  name: string;
  api: { id: string; npm: string };
  headers: Record<string, string>;
  options: Record<string, unknown>;
  cost: {
    input: number;
    output: number;
    cache: { read: number; write: number };
  };
  limit: { context: number; output: number };
  capabilities: {
    reasoning: boolean;
    input: { text: boolean; image: boolean };
    output: { text: boolean };
  };
}

afterAll(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
});

function pnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function gatewayConfig(): OpenCodeConfig {
  return {
    enabled_providers: [...PROVIDERS],
    provider: Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        { options: { baseURL: `https://gateway.invalid/${provider}` } },
      ]),
    ),
  };
}

function parseModels(stdout: string): Map<string, OracleModel> {
  const prefixes = new Set<string>(PROVIDERS);
  const lines = stdout.replaceAll(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const models = new Map<string, OracleModel>();
  for (let index = 0; index < lines.length; index += 1) {
    const id = lines[index]!.trim();
    if (!prefixes.has(id.slice(0, id.indexOf("/")))) continue;

    let json = "";
    let parsed: OracleModel | undefined;
    for (index += 1; index < lines.length; index += 1) {
      json += `${lines[index]}\n`;
      try {
        parsed = JSON.parse(json) as OracleModel;
        break;
      } catch {
        // Pretty-printed JSON is incomplete until its final closing brace.
      }
    }
    if (!parsed) throw new Error(`Could not parse OpenCode metadata for ${id}`);
    models.set(id, parsed);
  }
  return models;
}

function resolveWithOpenCode(
  config: OpenCodeConfig,
  catalog: ModelsCatalog,
): Map<string, OracleModel> {
  const root = mkdtempSync(join(tmpdir(), "pi-opencode-oracle-"));
  temporaryRoots.push(root);
  const directories = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    state: join(root, "state"),
    project: join(root, "project"),
  };
  for (const directory of Object.values(directories)) {
    mkdirSync(directory, { recursive: true });
  }
  const catalogPath = join(root, "models.json");
  writeFileSync(catalogPath, JSON.stringify(catalog));

  const result = spawnSync(
    pnpmCommand(),
    ["dlx", `opencode-ai@${OPENCODE_VERSION}`, "models", "--verbose"],
    {
      cwd: directories.project,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${resolve("node_modules", ".bin")}${delimiter}${process.env["PATH"] ?? ""}`,
        NO_COLOR: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_MODELS_PATH: catalogPath,
        OPENCODE_PURE: "true",
        XDG_CACHE_HOME: directories.cache,
        XDG_CONFIG_HOME: directories.config,
        XDG_DATA_HOME: directories.data,
        XDG_STATE_HOME: directories.state,
      },
    },
  );

  if (result.error) throw result.error;
  expect(
    result.status,
    `OpenCode ${OPENCODE_VERSION} failed:\n${result.stderr || result.stdout}`,
  ).toBe(0);
  return parseModels(result.stdout);
}

function accountedModelIds(resolved: ResolvedCatalog): string[] {
  return [
    ...resolved.models.map((entry) => entry.model.id),
    ...resolved.skippedModels.map((entry) => entry.id),
  ].sort();
}

describe("OpenCode resolver differential", () => {
  it(`matches OpenCode ${OPENCODE_VERSION} across Pi-compatible providers`, async () => {
    const response = await fetch(MODELS_URL);
    expect(
      response.ok,
      `Failed to fetch ${MODELS_URL}: ${response.status}`,
    ).toBe(true);
    const catalog = (await response.json()) as ModelsCatalog;
    const config = gatewayConfig();
    const opencodeModels = resolveWithOpenCode(config, catalog);
    const resolved = resolveGatewayCatalog(config, catalog, false);

    expect(accountedModelIds(resolved)).toEqual(
      [...opencodeModels.keys()].sort(),
    );
    expect(
      resolved.skippedModels.filter((entry) =>
        entry.reason.startsWith("Unsupported OpenCode provider package"),
      ),
    ).toEqual([]);
    expect(
      resolved.models
        .filter((entry) => entry.upstreamProviderId === "xai")
        .map((entry) => entry.model.api),
    ).not.toContain("openai-completions");
    expect(resolved.providerModelCounts["xai"]).toBeGreaterThan(0);

    for (const entry of resolved.models) {
      const oracle = opencodeModels.get(entry.model.id);
      expect(oracle, entry.model.id).toBeDefined();
      expect(entry.upstreamModelId, entry.model.id).toBe(oracle!.api.id);
      expect(entry.npm, entry.model.id).toBe(oracle!.api.npm);
      expect(entry.model.reasoning, entry.model.id).toBe(
        oracle!.capabilities.reasoning,
      );
      expect(entry.model.input, entry.model.id).toEqual([
        ...(oracle!.capabilities.input.text ? (["text"] as const) : []),
        ...(oracle!.capabilities.input.image ? (["image"] as const) : []),
      ]);
      expect(entry.model.cost, entry.model.id).toMatchObject({
        input: oracle!.cost.input,
        output: oracle!.cost.output,
        cacheRead: oracle!.cost.cache.read,
        cacheWrite: oracle!.cost.cache.write,
      });
      expect(entry.model.contextWindow, entry.model.id).toBe(
        oracle!.limit.context || 128_000,
      );
      expect(entry.model.maxTokens, entry.model.id).toBe(
        oracle!.limit.output || 8_192,
      );
      expect(entry.model.headers, entry.model.id).toEqual(oracle!.headers);
      expect(entry.model.samplingParams ?? {}, entry.model.id).toEqual(
        oracle!.options,
      );
    }
  }, 150_000);
});
