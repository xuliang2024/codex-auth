use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri_plugin_http::reqwest::{self, Client, StatusCode};

use crate::registry::{
    self, account_auth_path, active_auth_path, load_registry, read_auth_value, write_private_file,
    DEFAULT_PROVIDER_MODEL,
};

const USAGE_ENDPOINT: &str = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_ENDPOINT: &str = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_ANNOUNCEMENTS_ENDPOINT: &str =
    "https://codex-auth-telemetry.xuliang2022.workers.dev/v1/announcements";
const DEFAULT_SHARE_API_BASE: &str = "https://codexhub.uk";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestApiOptions {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone)]
pub struct UsageStatus {
    pub ok: bool,
    pub expired: bool,
    pub error: Option<String>,
    pub usage: Option<Value>,
}

impl UsageStatus {
    fn failure(expired: bool, error: impl Into<String>) -> Self {
        Self {
            ok: false,
            expired,
            error: Some(error.into()),
            usage: None,
        }
    }
}

pub fn build_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(format!(
            "codex-auth-desktop-tauri/{}",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|error| format!("Failed to initialize the HTTP client: {error}"))
}

async fn response_body_text(response: reqwest::Response) -> (StatusCode, String) {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    (status, text)
}

pub async fn test_api_endpoint(client: &Client, options: TestApiOptions) -> Value {
    let Some(base_url) = registry::normalize_provider_base_url(&options.base_url) else {
        return json!({ "ok": false, "code": "invalid_url", "error": "Enter a full endpoint URL such as https://codex.example.com" });
    };
    if registry::is_native_anthropic_base_url(&base_url) {
        return json!({
            "ok": false,
            "fatal": true,
            "code": "unsupported_anthropic_protocol",
            "error": "Native Anthropic Messages endpoints are not supported by Codex. Use a Responses-compatible Claude gateway endpoint."
        });
    }
    let api_key = options.api_key.trim();
    if api_key.is_empty() {
        return json!({ "ok": false, "code": "missing_key", "error": "Enter the API key first." });
    }
    let model = if options.model.trim().is_empty() {
        DEFAULT_PROVIDER_MODEL
    } else {
        options.model.trim()
    };
    let response = client
        .post(format!("{base_url}/responses"))
        .bearer_auth(api_key)
        .timeout(Duration::from_secs(45))
        .json(&json!({
            "model": model,
            "input": [{
                "role": "user",
                "content": [{ "type": "input_text", "text": "Reply with the single word: ok" }]
            }],
            "stream": false
        }))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            let reason = if error.is_timeout() {
                "request timed out after 45s".to_string()
            } else {
                error.to_string()
            };
            return json!({ "ok": false, "code": "unreachable", "error": format!("Cannot reach endpoint: {reason}") });
        }
    };
    let (status, body_text) = response_body_text(response).await;
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return json!({
            "ok": false,
            "code": "authentication_failed",
            "status": status.as_u16(),
            "error": format!("Authentication failed (HTTP {}) — check the API key.", status.as_u16())
        });
    }
    if status == StatusCode::NOT_FOUND {
        return json!({
            "ok": false,
            "code": "responses_not_found",
            "status": 404,
            "error": "Endpoint responded with HTTP 404 — check the URL (the /responses path was not found)."
        });
    }
    if !status.is_success() {
        let snippet = body_text.split_whitespace().collect::<Vec<_>>().join(" ");
        let snippet = snippet.chars().take(160).collect::<String>();
        return json!({
            "ok": false,
            "code": "endpoint_error",
            "status": status.as_u16(),
            "error": format!(
                "Endpoint returned HTTP {}{}",
                status.as_u16(),
                if snippet.is_empty() { String::new() } else { format!(": {snippet}") }
            )
        });
    }
    let parsed = match serde_json::from_str::<Value>(&body_text) {
        Ok(body) if body.get("output").and_then(Value::as_array).is_some() => body,
        Ok(_) => {
            return json!({
                "ok": false,
                "code": "invalid_responses_payload",
                "status": status.as_u16(),
                "error": "Endpoint returned HTTP 200 but not a valid Responses API payload."
            })
        }
        Err(_) => {
            return json!({
                "ok": false,
                "code": "invalid_responses_payload",
                "status": status.as_u16(),
                "error": "Endpoint returned HTTP 200 but not valid JSON for the Responses API."
            })
        }
    };
    let responded_model = parsed.get("model").and_then(Value::as_str);
    let reply = parsed
        .get("output")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        })
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("type").and_then(Value::as_str) == Some("output_text"))
        })
        .and_then(|item| item.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|text| text.chars().take(80).collect::<String>());
    json!({
        "ok": true,
        "status": status.as_u16(),
        "model": responded_model,
        "reply": reply
    })
}

async fn refresh_auth_tokens(
    client: &Client,
    auth_path: &Path,
    snapshot_path: Option<&Path>,
    auth: &mut Value,
) -> Result<(), String> {
    let refresh_token = auth
        .pointer("/tokens/refresh_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "no refresh token stored".to_string())?;
    let response = client
        .post(TOKEN_ENDPOINT)
        .timeout(Duration::from_secs(30))
        .json(&json!({
            "client_id": OAUTH_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": "openid profile email"
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("token refresh returned HTTP {}", status.as_u16()));
    }
    let body = response
        .json::<Value>()
        .await
        .map_err(|_| "token refresh response was not JSON".to_string())?;
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "token refresh response had no access token".to_string())?;
    auth["tokens"]["access_token"] = Value::String(access_token.to_string());
    if let Some(id_token) = body.get("id_token").and_then(Value::as_str) {
        auth["tokens"]["id_token"] = Value::String(id_token.to_string());
    }
    if let Some(refresh_token) = body.get("refresh_token").and_then(Value::as_str) {
        auth["tokens"]["refresh_token"] = Value::String(refresh_token.to_string());
    }
    auth["last_refresh"] = Value::String(chrono::Utc::now().to_rfc3339());
    persist_refreshed_auth(auth_path, snapshot_path, auth)
}

fn persist_refreshed_auth(
    auth_path: &Path,
    snapshot_path: Option<&Path>,
    auth: &Value,
) -> Result<(), String> {
    let mut serialized = serde_json::to_string_pretty(auth).map_err(|error| error.to_string())?;
    serialized.push('\n');
    write_private_file(auth_path, &serialized)
        .map_err(|error| format!("failed to save refreshed tokens: {error}"))?;
    if let Some(path) = snapshot_path {
        write_private_file(path, &serialized)
            .map_err(|error| format!("failed to save refreshed account snapshot: {error}"))?;
    }
    Ok(())
}

async fn fetch_usage(
    client: &Client,
    access_token: &str,
    account_id: &str,
) -> Result<reqwest::Response, String> {
    client
        .get(USAGE_ENDPOINT)
        .bearer_auth(access_token)
        .header("ChatGPT-Account-Id", account_id)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "timed out".into()
            } else {
                error.to_string()
            }
        })
}

fn parse_usage_window(window: Option<&Value>) -> Option<Value> {
    let window = window?;
    let used_percent = window.get("used_percent")?.as_f64()?;
    let minutes = window
        .get("limit_window_seconds")
        .and_then(Value::as_f64)
        .filter(|seconds| *seconds > 0.0)
        .map(|seconds| (seconds / 60.0).ceil() as i64);
    Some(json!({
        "used_percent": used_percent,
        "window_minutes": minutes,
        "resets_at": window.get("reset_at").and_then(Value::as_i64)
    }))
}

pub async fn fetch_account_usage_status(
    client: &Client,
    codex_home: &Path,
    account_key: &str,
) -> UsageStatus {
    let registry = match load_registry(codex_home) {
        Ok(registry) => registry,
        Err(error) => return UsageStatus::failure(false, error),
    };
    let live_path = active_auth_path(codex_home);
    let uses_active_auth =
        registry.active_account_key.as_deref() == Some(account_key) && live_path.exists();
    let auth_path = if uses_active_auth {
        live_path
    } else {
        account_auth_path(codex_home, account_key)
    };
    let refreshed_snapshot_path =
        uses_active_auth.then(|| account_auth_path(codex_home, account_key));
    let mut auth = match read_auth_value(&auth_path) {
        Some(auth) => auth,
        None => {
            return UsageStatus::failure(
                true,
                "Cannot read stored auth for this account: auth snapshot not found",
            )
        }
    };
    if auth.get("OPENAI_API_KEY").and_then(Value::as_str).is_some() {
        return UsageStatus::failure(false, "API-key account — usage is not available.");
    }
    let account_id = match auth.pointer("/tokens/account_id").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return UsageStatus::failure(true, "Stored auth is missing an access token."),
    };
    let mut access_token = match auth.pointer("/tokens/access_token").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return UsageStatus::failure(true, "Stored auth is missing an access token."),
    };

    let mut response = match fetch_usage(client, &access_token, &account_id).await {
        Ok(response) => response,
        Err(error) => return UsageStatus::failure(false, format!("Usage request failed: {error}")),
    };
    if response.status() == StatusCode::UNAUTHORIZED {
        if let Err(error) = refresh_auth_tokens(
            client,
            &auth_path,
            refreshed_snapshot_path.as_deref(),
            &mut auth,
        )
        .await
        {
            return UsageStatus::failure(
                true,
                format!("Session expired — sign in again with Add Account. ({error})"),
            );
        }
        access_token = auth
            .pointer("/tokens/access_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        response = match fetch_usage(client, &access_token, &account_id).await {
            Ok(response) => response,
            Err(error) => {
                return UsageStatus::failure(false, format!("Usage request failed: {error}"))
            }
        };
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return UsageStatus::failure(
                true,
                format!(
                    "Usage API rejected the refreshed session (HTTP {}).",
                    response.status().as_u16()
                ),
            );
        }
    }
    if !response.status().is_success() {
        return UsageStatus::failure(
            false,
            format!("Usage API returned HTTP {}", response.status().as_u16()),
        );
    }
    let body = match response.json::<Value>().await {
        Ok(body) => body,
        Err(_) => {
            return UsageStatus::failure(false, "Usage API returned an unparseable response.")
        }
    };
    let primary = parse_usage_window(body.pointer("/rate_limit/primary_window"));
    let secondary = parse_usage_window(body.pointer("/rate_limit/secondary_window"));
    if primary.is_none() && secondary.is_none() {
        return UsageStatus::failure(false, "Usage API response contained no rate limit data.");
    }
    let credits = body.get("credits").filter(|value| value.is_object()).map(|credits| {
        json!({
            "has_credits": credits.get("has_credits").and_then(Value::as_bool) == Some(true),
            "unlimited": credits.get("unlimited").and_then(Value::as_bool) == Some(true),
            "balance": credits.get("balance").and_then(Value::as_str).filter(|value| !value.is_empty())
        })
    });
    UsageStatus {
        ok: true,
        expired: false,
        error: None,
        usage: Some(json!({
            "primary": primary,
            "secondary": secondary,
            "credits": credits,
            "plan_type": body.get("plan_type").and_then(Value::as_str).map(str::to_lowercase)
        })),
    }
}

pub async fn get_announcements(
    client: &Client,
    opts: Value,
    platform: &str,
    version: &str,
) -> Value {
    let endpoint = std::env::var("CODEX_AUTH_ANNOUNCEMENTS_ENDPOINT")
        .unwrap_or_else(|_| DEFAULT_ANNOUNCEMENTS_ENDPOINT.into());
    let mut url = match url::Url::parse(&endpoint) {
        Ok(url) => url,
        Err(error) => {
            return json!({ "ok": false, "error": error.to_string(), "announcements": [] })
        }
    };
    let locale = opts
        .get("locale")
        .and_then(Value::as_str)
        .unwrap_or("en")
        .split(['-', '_'])
        .next()
        .unwrap_or("en")
        .to_lowercase();
    url.query_pairs_mut()
        .append_pair("app", "codex-auth-desktop")
        .append_pair("version", version)
        .append_pair("platform", platform)
        .append_pair("locale", &locale);
    let response = match client
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return json!({ "ok": false, "error": format!("Announcement request failed: {error}"), "announcements": [] })
        }
    };
    if !response.status().is_success() {
        return json!({
            "ok": false,
            "error": format!("Announcement API returned HTTP {}", response.status().as_u16()),
            "announcements": []
        });
    }
    let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    let announcements = body
        .get("announcements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    json!({
        "ok": true,
        "announcements": announcements,
        "ttl_seconds": body.get("ttl_seconds").and_then(Value::as_u64).unwrap_or(300).clamp(60, 3600)
    })
}

fn uuid_regex() -> &'static Regex {
    static UUID: OnceLock<Regex> = OnceLock::new();
    UUID.get_or_init(|| {
        Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
            .expect("valid UUID regex")
    })
}

fn parse_share_id(raw: &str) -> Option<String> {
    let text = raw.trim();
    let found = uuid_regex().find(text)?.as_str().to_lowercase();
    if text.eq_ignore_ascii_case(&found) || text.contains("/share/") || text.contains("/v1/shares/")
    {
        Some(found)
    } else {
        None
    }
}

fn share_base() -> String {
    std::env::var("CODEX_AUTH_SHARE_API_BASE")
        .unwrap_or_else(|_| DEFAULT_SHARE_API_BASE.into())
        .trim_end_matches('/')
        .to_string()
}

pub async fn upload_share(client: &Client, export: Value, opts: &Value, version: &str) -> Value {
    let response = client
        .post(format!("{}/v1/shares", share_base()))
        .timeout(Duration::from_secs(30))
        .json(&json!({
            "export": export,
            "note": opts.get("note").cloned().unwrap_or(Value::Null),
            "ttl_days": opts.get("ttlDays").and_then(Value::as_u64).unwrap_or(7),
            "exported_by_app": "codex-auth-desktop",
            "exported_by_version": version
        }))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return json!({ "ok": false, "error": format!("Share upload failed: {error}") })
        }
    };
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return json!({
            "ok": false,
            "error": body.get("error").and_then(Value::as_str).map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("Share upload failed (HTTP {}).", status.as_u16()))
        });
    }
    json!({
        "ok": true,
        "id": body.get("id"),
        "shareUrl": body.get("share_url"),
        "importUrl": body.get("import_url"),
        "expiresAt": body.get("expires_at")
    })
}

pub async fn fetch_share_export(client: &Client, raw_url: &str) -> Value {
    let Some(id) = parse_share_id(raw_url) else {
        return json!({ "ok": false, "error": "Invalid share link." });
    };
    let response = match client
        .get(format!("{}/v1/shares/{id}/export", share_base()))
        .timeout(Duration::from_secs(30))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return json!({ "ok": false, "error": format!("Failed to download share: {error}") })
        }
    };
    match response.status() {
        StatusCode::NOT_FOUND => return json!({ "ok": false, "error": "Share not found." }),
        StatusCode::GONE => return json!({ "ok": false, "error": "Share link has expired." }),
        status if !status.is_success() => {
            return json!({ "ok": false, "error": format!("Failed to download share (HTTP {}).", status.as_u16()) });
        }
        _ => {}
    }
    match response.json::<Value>().await {
        Ok(payload) => json!({ "ok": true, "payload": payload, "shareId": id }),
        Err(error) => json!({ "ok": false, "error": format!("Invalid share payload: {error}") }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_id_accepts_supported_shapes_only() {
        let id = "c14f2f20-3a6b-4f74-8f31-a1c74dc3312f";
        assert_eq!(parse_share_id(id).as_deref(), Some(id));
        assert_eq!(parse_share_id(&id.to_uppercase()).as_deref(), Some(id));
        assert_eq!(
            parse_share_id(&format!("https://codexhub.uk/share/{id}")).as_deref(),
            Some(id)
        );
        assert_eq!(
            parse_share_id(&format!("https://example.com/not-share/{id}")),
            None
        );
        assert_eq!(parse_share_id("not-a-link"), None);
    }

    #[test]
    fn usage_window_maps_seconds_to_minutes() {
        let parsed = parse_usage_window(Some(&json!({
            "used_percent": 42.5,
            "limit_window_seconds": 18000,
            "reset_at": 1234
        })))
        .unwrap();
        assert_eq!(
            parsed.get("window_minutes").and_then(Value::as_i64),
            Some(300)
        );
        assert_eq!(parsed.get("resets_at").and_then(Value::as_i64), Some(1234));
    }

    #[test]
    fn refreshed_active_auth_is_mirrored_to_the_account_snapshot() {
        let root =
            std::env::temp_dir().join(format!("codex-auth-refresh-test-{}", uuid::Uuid::new_v4()));
        let live_path = root.join("auth.json");
        let snapshot_path = root.join("accounts/account.auth.json");
        let auth = json!({
            "auth_mode": "chatgpt",
            "last_refresh": "2026-07-11T00:00:00Z",
            "tokens": {
                "access_token": "access-token",
                "refresh_token": "refresh-token"
            }
        });

        persist_refreshed_auth(&live_path, Some(&snapshot_path), &auth).unwrap();

        assert_eq!(read_auth_value(&live_path), Some(auth.clone()));
        assert_eq!(read_auth_value(&snapshot_path), Some(auth));
        std::fs::remove_dir_all(root).unwrap();
    }
}
