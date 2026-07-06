# Share Links

Phase 1 adds online account-config sharing for the desktop app.

## Endpoints

Production host: `https://codexhub.uk`

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/shares` | Create a share from a desktop export payload |
| `GET` | `/v1/shares/{uuid}/export` | Download the full export JSON for import |
| `GET` | `/share/{uuid}` | Public HTML summary page |

## Desktop Usage

### Export

1. Click **Export**
2. Choose **Create Share Link…**
3. Confirm the security warning
4. Optionally add a note
5. Copy the generated link

The link expires after 7 days.

### Import

1. Click **Import**
2. Choose **Paste Share Link…**
3. Paste the share URL or import URL
4. Confirm import

## Storage Layout

R2 bucket `codexhub`:

```text
shares/{uuid}/meta.json
shares/{uuid}/export.json
```

`meta.json` is used by the HTML page and contains masked emails only.
`export.json` contains the full desktop export payload.

## Upload Access

`POST /v1/shares` is intentionally available to the desktop app without a private upload token. The endpoint validates the export payload, body size, and TTL before storing a share.

Optional desktop API base override:

```text
CODEX_AUTH_SHARE_API_BASE=https://codexhub.uk
```

## Deploy

From `site/`:

```sh
npx wrangler deploy
```

## Privacy

- Do not send share URLs, account emails, or tokens to telemetry.
- Treat share links like credential exports.
