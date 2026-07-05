# API Provider Login — Implementation Plan

Goal: support a second login method — "API provider login" (custom endpoint
`base_url` + API key, e.g. `https://codex.apiz.ai`) — as a first-class account
type that can be switched to and from ChatGPT OAuth accounts with the existing
`switch` flow (CLI picker, `switch <query>`, desktop app).

## 1. Background / current state

- ChatGPT accounts: `~/.codex/auth.json` holds OAuth tokens; per-account
  snapshots live in `~/.codex/accounts/<key>.auth.json`; switching just swaps
  `auth.json` (`registry/account_ops.zig: activateAccountByKey`).
- An `apikey` auth mode already exists, but it assumes an **official** OpenAI
  platform key: it validates via `https://api.openai.com/v1/me`
  (`api/me.zig`), which fails for relay providers.
- Nothing in codex-auth touches `~/.codex/config.toml` today (only
  `workflows/app.zig` reads/writes the WSL desktop setting).
- A provider account requires BOTH files:
  - `auth.json` → `{ "OPENAI_API_KEY": "sk-..." }`
  - `config.toml` → `model_provider = "X"` plus a `[model_providers.X]` table
    (`base_url`, `wire_api = "responses"`, `requires_openai_auth = true`) and
    optionally model settings (`model`, `model_reasoning_effort`, ...).

## 2. Data model (registry schema v5)

- Bump `current_schema_version` to 5 (`registry/common.zig`).
- Add `AuthMode.provider` (distinct from `apikey`, which keeps meaning
  "official OpenAI platform key").
- Extend `AccountRecord` with an optional provider config:

```json
{
  "account_key": "provider::codex.apiz.ai::<sha256(key) hex>",
  "email": "apiz.ai",                 // display label = provider host
  "alias": "apiz",                    // user-chosen name (optional)
  "auth_mode": "provider",
  "provider": {
    "id": "apiz",                     // TOML table key, sanitized
    "base_url": "https://codex.apiz.ai",
    "wire_api": "responses",
    "requires_openai_auth": true,
    "model": "gpt-5.5",               // optional overrides
    "model_reasoning_effort": "xhigh",
    "extra_top_level": { "disable_response_storage": "true" }
  }
}
```

- `account_key` = `provider::<host>::<sha256(api_key)>` — no network call
  needed to derive identity (unlike `apikey::` which needs `/v1/me`).
- Parsing: `storage_parse.zig` gains `parseProviderConfig`; writing is free via
  `std.json.Stringify` once the struct field exists. Older registries load
  fine (min supported version stays 2); records without `provider` behave as
  before.
- The API key itself stays only in the auth snapshot
  (`accounts/<key>.auth.json`), not in `registry.json`, matching how ChatGPT
  tokens are handled today.

## 3. config.toml manager (new module `src/codex_config/toml.zig`)

The core new capability. Marker-based managed regions, never touching user
content outside them:

```toml
# >>> codex-auth provider (do not edit) >>>
model_provider = "apiz"
model = "gpt-5.5"
model_reasoning_effort = "xhigh"
# <<< codex-auth provider <<<

...user's own config...

# >>> codex-auth provider tables (do not edit) >>>
[model_providers.apiz]
name = "apiz"
base_url = "https://codex.apiz.ai"
wire_api = "responses"
requires_openai_auth = true
# <<< codex-auth provider tables <<<
```

Important TOML constraint: top-level scalar keys must appear **before** the
first `[table]`, so the managed content is split into two regions:

- **head block** (scalar keys: `model_provider`, `model`, ...) inserted at the
  very top of the file;
- **tail block** (`[model_providers.X]` table) appended at the end.

Operations (pure functions over file bytes, easily unit-testable):

- `applyProviderBlocks(content, provider) -> new content` — replaces existing
  managed regions or inserts them; creates the file if missing.
- `removeProviderBlocks(content) -> new content` — strips both regions
  (used when switching to a ChatGPT account).
- Back up `config.toml` into `accounts/backups/` before every modification,
  reusing the `max_backups = 5` rotation from `registry/clean.zig`.

We do NOT parse arbitrary TOML — only our own marker lines — which keeps user
comments/edits safe.

## 4. Switch integration

Extend `activateAccountByKey` (and the two `replaceActiveAuthWithAccountByKey*`
variants) in `registry/account_ops.zig`:

1. Swap `auth.json` from the account snapshot (unchanged).
2. Then reconcile `config.toml`:
   - target account has `provider` → `applyProviderBlocks`;
   - target account is ChatGPT/apikey → `removeProviderBlocks`.

Both writes happen in this order so a crash between them leaves codex pointing
at the OpenAI default with a provider key — harmless (auth fails cleanly),
whereas the reverse order could send ChatGPT tokens to a third-party endpoint.

`syncActiveAccountFromAuth` (runs on every list/switch): when `auth.json`
contains `OPENAI_API_KEY`, first match `sha256(key)` against existing
`provider::` accounts **before** calling `/v1/me`, so provider accounts don't
trigger the official-API probe (which fails and spams warnings today).

## 5. CLI surface

New login form (in `cli/commands/login.zig` + `workflows/login.zig`):

```
codex-auth login --api --base-url https://codex.apiz.ai --key sk-... [--name apiz]
codex-auth login --api        # interactive prompts for endpoint / key / name
```

Behavior:

- Normalize/validate the base_url (https, strip trailing slash); derive
  `provider.id` from `--name` or the host (sanitized to `[A-Za-z0-9_-]`).
- Optional light connectivity probe (HEAD/GET base_url); failure is a warning,
  not an error — many relays only accept POSTs.
- Write snapshot `accounts/<key>.auth.json` = `{"OPENAI_API_KEY": "..."}`,
  upsert the record, activate it (which also applies the config blocks).

Other commands:

- `list` / pickers: provider accounts render the host as the identity, an
  `API` tag in the plan column, and `-` for usage (usage refresh already skips
  non-chatgpt modes via `shouldRefreshChatGptUsageForAccount`; extend that
  check to `.provider`).
- `switch` / `remove`: no interface changes; `remove` of the active provider
  account also runs `removeProviderBlocks`.
- Help text updated (English only, per repo rules).

## 6. Desktop app (`desktop/`)

- "Add Account" becomes a split action: **ChatGPT sign-in** (existing flow) and
  **API endpoint** (small form: endpoint URL, API key, optional name), which
  invokes `codex-auth login --api --base-url ... --key ...` via the existing
  `runCli` helper.
- Provider account cards: `API` badge + endpoint host, no usage bars, excluded
  from the expired-session check in `check-accounts` (they have no OAuth
  session; optionally show a "reachable/unreachable" hint from a HEAD probe).
- Switch/remove buttons work unchanged since they shell out to the CLI.

## 7. Edge cases

- `config.toml` missing → create it with just the managed blocks.
- User already has a manual `model_provider` line outside our markers → leave
  it; our head block is inserted above, so ours wins (TOML last-wins is NOT
  true — duplicate keys are an error). Mitigation: on apply, scan for a bare
  `model_provider =` outside managed regions and fail with a clear message
  telling the user to remove it (one-time migration).
- Same endpoint with different keys → distinct accounts (key hash in
  `account_key`).
- Old codex-auth versions reading a v5 registry: unknown fields are ignored by
  the tolerant parser, so nothing breaks; they'd just treat the record as a
  plain account with no usable auth semantics.

## 8. Testing

- Unit tests (`tests/`): TOML block apply/replace/remove round-trips incl. the
  head/tail split and the duplicate `model_provider` guard; registry v5
  parse/serialize round-trip; provider `account_key` derivation; switch
  workflow with a temp `CODEX_HOME` asserting both `auth.json` and
  `config.toml` end states in both directions (chatgpt→provider→chatgpt).
- Run from an isolated `/tmp/<task>` HOME per repo rules; `zig build run --
  list` after every Zig change.
- Desktop: manual pass — add API account, switch both ways, verify
  `~/.codex/config.toml` content each time.

## 9. Implementation order

1. Registry schema v5 (`provider` field, `AuthMode.provider`, parse/write + tests).
2. `codex_config/toml.zig` managed-block engine + tests.
3. Hook into `activateAccountByKey` / sync + switch workflow tests.
4. `login --api` CLI (args, prompts, workflow) + list/picker display.
5. Desktop UI (add form, badges, exclude from expiry check).
6. Docs: `docs/api-provider.md` usage guide; README gets one short mention.

## 10. Implementation notes (as built)

- The managed-block engine lives at `src/registry/provider_toml.zig` (not
  `codex_config/toml.zig`).
- Conflicting user-defined top-level keys (`model_provider`, `model`,
  `review_model`, `model_reasoning_effort`, `disable_response_storage`) are
  not treated as fatal. They are commented out with the
  `#codex-auth:disabled# ` prefix when a provider is activated and restored
  verbatim when switching back to a ChatGPT account.
- `login --api` is flag-driven only (`--base-url`, `--key`, plus optional
  `--name`, `--model`, `--reasoning-effort`); no interactive prompts.
- Provider accounts show the plan label `API` in `list` and an `API` badge in
  the desktop app; usage refresh skips them entirely.
