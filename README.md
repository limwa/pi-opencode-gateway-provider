# Pi OpenCode Gateway Provider

A native [Pi](https://pi.dev) model provider for OpenCode-compatible gateways.
It discovers authentication from `/.well-known/opencode`, runs the gateway's
declared login command, loads its remote OpenCode config, and exposes the
resulting model catalog through one `OpenCode Gateway` account in Pi.

## Features

- Native `/login` integration with an interactive gateway-host prompt
- OpenCode-compatible well-known discovery and authentication commands
- Embedded plus remote config deep merging, including `{env:...}` and
  `{file:...}` substitution
- Current [models.dev](https://models.dev) catalog inheritance for providers
  whose OpenCode config declares no explicit models
- OpenCode `enabled_providers`, `disabled_providers`, `whitelist`, and
  `blacklist` semantics
- Model aliases, endpoint overrides, headers, request options, costs, limits,
  modalities, experimental modes, and alpha/deprecated filtering
- Anthropic Messages, OpenAI Responses, OpenAI-compatible Chat Completions,
  Google Generative AI, and Mistral Conversations transports
- JWT expiration tracking and proactive expiration warnings
- Actionable authentication, network, config, catalog, and HTTP 403 errors
- `/opencode-gateway-status` diagnostics without displaying credentials
- Effect v4 runtime state and typed failures

## Install

Build and install a local checkout:

```sh
direnv exec . corepack pnpm install
direnv exec . corepack pnpm build
pi install /absolute/path/to/pi-opencode-gateway-provider
```

For a one-off development run:

```sh
pi --extension ./dist/index.js
```

The authentication executable named by the gateway must be available on Pi's
`PATH`. The public Cloudflare gateway currently declares `cloudflared`; on
NixOS, run Pi from an environment that contains that package or add it to your
normal system/user environment.

## Use

1. Run `/login` in Pi.
2. Select `OpenCode Gateway`.
3. Enter the host, such as `gateway.example.com`. A scheme is optional and
   defaults to HTTPS.
4. Complete the authentication flow opened by the gateway command.
5. Select any available `opencode-gateway/<upstream>/<model>` entry via
   `/model`.

Run `/opencode-gateway-status` to inspect the gateway URL, token kind and
expiration, loaded model counts by upstream provider, skipped models, refresh
time, warnings, and the most recent error.

Opaque tokens have no trustworthy expiration claim and are treated as valid
indefinitely. JWTs use their `exp` claim. Pi displays a warning when a JWT is
within 15 minutes of expiration. These command-issued credentials cannot be
refreshed without user interaction, so an expired token or any HTTP 403 asks
the user to authenticate again through `/login`.

## OpenCode compatibility

The resolver mirrors the relevant OpenCode provider pipeline:

1. Normalize the host and fetch `/.well-known/opencode`.
2. Execute `auth.command` directly, without a shell, and capture stdout as the
   token named by `auth.env`.
3. Substitute that environment value into `remote_config`, fetch it, and merge
   the result over embedded `config`.
4. Apply config-wide environment/file substitution.
5. Start each declared provider from its models.dev catalog, then overlay
   provider and model config.
6. Apply enabled/disabled provider filters, model status filters, then each
   provider's blacklist and whitelist.
7. Remove providers left with no models.

Model IDs are namespaced with their upstream provider to prevent collisions.
Aliases retain their public Pi ID while the request adapter sends the real
OpenCode `model.id` upstream.

OpenCode can dynamically install arbitrary AI SDK provider packages. Pi uses a
fixed set of native streaming protocols, so a model with an API shape that
cannot be mapped safely is omitted and reported by the status command. The
protocols used by the Cloudflare OpenCode gateway—Anthropic, OpenAI, Google,
and Workers AI's OpenAI-compatible endpoint—are covered.

## Security

Only authenticate to gateways you trust. OpenCode gateway discovery is
explicitly designed to return a local command for the client to execute; this
extension follows that contract and never invokes it through a shell.

Pi persists the credential in its normal auth store. The token is deliberately
not embedded in Pi's dynamic model cache: config references are stored as an
internal sentinel and materialized from the active credential only in memory,
immediately before a request. Status output never includes token contents.

## Development

The repository uses the declared Nix environment, pnpm, strict TypeScript, and
Vitest:

```sh
direnv exec . corepack pnpm verify
direnv exec . corepack pnpm test:coverage
```

The tests cover discovery validation, host normalization, command execution,
JWT and opaque-token handling, remote config merging and redaction, provider
and model filtering, catalog inheritance, aliases, experimental modes,
environment URL expansion, status output, extension registration, and a full
request-path 403 integration case.

## License

MIT
