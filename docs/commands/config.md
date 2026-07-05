# `codex-auth config`

## Usage

```shell
codex-auth config live --interval <seconds>
codex-auth config fix
```

## Live Refresh Config

`config live --interval <seconds>` sets the live TUI refresh interval.

- Allowed range: `5` to `3600`.
- Stored in `registry.json` as top-level `interval_seconds`.

## Config Repair

`config fix` reconciles `config.toml` with the active account:

- Provider account active: re-applies the managed provider blocks (head scalars and `[model_providers.<id>]` table between the `codex-auth provider` markers).
- ChatGPT or API-key account active: removes the managed blocks, restores lines disabled with `#codex-auth:disabled#`, and comments out unmanaged top-level `model_provider` overrides with `#codex-auth:incompatible#`.

An unmanaged `model_provider` key written outside the managed markers reroutes every account to a custom endpoint. That combination breaks ChatGPT and API-key accounts (the endpoint receives OAuth tokens instead of the API key it expects, typically failing with `401 INVALID_API_KEY`). Account switching applies the same quarantine automatically; `config fix` exists to repair a `config.toml` that was rewritten by hand or by another tool between switches. The previous file content is backed up under `accounts/config.toml.bak.<timestamp>` before any rewrite.

Quarantined lines are never restored automatically. To route accounts through a custom endpoint, use a provider account (`codex-auth login --api`) instead of a hand-written `model_provider` override.

## API Refresh

API-backed refresh is the default for supported foreground paths. Use per-command `--skip-api` to run a foreground command with local data only. Older `registry.json` files may contain an `api` object; current builds ignore it and omit it on the next registry save.

API behavior and endpoint details live in [docs/api.md](../api.md).
