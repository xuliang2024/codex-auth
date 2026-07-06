# Telemetry Backend

Accounts for Codex telemetry is an anonymous Cloudflare Worker ingest endpoint backed
by Cloudflare D1. It stores coarse feature usage and install activity only.

Current production endpoint:

```text
https://codex-auth-telemetry.xuliang2022.workers.dev/v1/telemetry/events
```

Current aggregate summary endpoint:

```text
https://codex-auth-telemetry.xuliang2022.workers.dev/v1/telemetry/summary
```

Hidden dashboard page:

```text
https://codexhub.uk/telemetry/
```

Current D1 database:

```text
codex-auth-telemetry
06e7bea3-5d5b-4095-a187-36f90b5c0ca9
```

## Privacy Boundary

Do not send or store:

- Email addresses
- OpenAI access tokens or refresh tokens
- API keys
- Provider endpoint URLs
- Account keys or account IDs
- Local file paths
- Imported or exported file names
- User-entered account names, aliases, or model names

The Worker also rejects common sensitive property names and string values that
look like emails, URLs, or tokens.

## Data Model

`telemetry_installs` stores one row per anonymous install:

- `install_id`
- `app`
- `app_version`
- `platform`
- `locale`
- `first_seen_at`
- `last_seen_at`
- `event_count`

`telemetry_events` stores event rows:

- `install_id`
- `app`
- `app_version`
- `platform`
- `locale`
- `event_name`
- `event_time`
- `received_at`
- `properties_json`

## Endpoint

`POST /v1/telemetry/events`

```json
{
  "install_id": "anonymous-random-uuid",
  "app": "codex-auth-desktop",
  "app_version": "0.1.1",
  "platform": "darwin",
  "locale": "zh",
  "events": [
    {
      "name": "app_start",
      "time": 1783260000,
      "properties": {
        "account_count": 5,
        "auth_mode_counts": { "chatgpt": 4, "provider": 1 },
        "plan_counts": { "pro": 1, "plus": 2, "go": 1, "api": 1 }
      }
    }
  ]
}
```

Successful response:

```json
{ "ok": true, "accepted": 1 }
```

Health check:

```text
GET /health
```

## Cloudflare Setup

From the repository root:

```sh
cd telemetry
npx wrangler d1 create codex-auth-telemetry
```

Copy the returned `database_id` into `telemetry/wrangler.json`.

Apply the schema:

```sh
npx wrangler d1 migrations apply codex-auth-telemetry --remote
```

Deploy the Worker:

```sh
npx wrangler deploy
```

Optional shared ingest token:

```sh
npx wrangler secret put TELEMETRY_INGEST_TOKEN
```

If `TELEMETRY_INGEST_TOKEN` is set, clients must send:

```text
x-telemetry-token: <token>
```

This token is not a strong security boundary for a public desktop app, but it
does filter accidental or casual traffic. Use Cloudflare WAF/rate limiting for
abuse protection.

## Suggested Events

- `app_start`
- `add_account_start`
- `add_account_success`
- `add_account_fail`
- `add_api_success`
- `add_api_fail`
- `switch_account`
- `refresh_usage_success`
- `refresh_usage_fail`
- `import_success`
- `import_fail`
- `export_success`
- `export_fail`

Keep event properties aggregate-only. Example:

```json
{
  "account_count": 5,
  "auth_mode_counts": { "chatgpt": 4, "provider": 1 },
  "plan_counts": { "pro": 1, "plus": 2, "go": 1, "api": 1 },
  "error_kind": "network_error"
}
```
