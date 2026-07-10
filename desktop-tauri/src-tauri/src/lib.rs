mod network;
mod oauth;
mod registry;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use futures::stream::{self, StreamExt as _};
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter as _, Manager as _, State};
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_opener::OpenerExt as _;

use crate::network::TestApiOptions;
use crate::oauth::{LoginCoordinator, OAuthOutcome};
use crate::registry::AddProviderOptions;

struct AppState {
    codex_home: PathBuf,
    client: tauri_plugin_http::reqwest::Client,
    login: LoginCoordinator,
    registry_lock: Mutex<()>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl AppState {
    fn new() -> Result<Self, String> {
        let codex_home = match std::env::var_os("CODEX_HOME") {
            Some(path) => PathBuf::from(path),
            None => home_directory()
                .ok_or_else(|| {
                    "Could not determine the current user's home directory.".to_string()
                })?
                .join(".codex"),
        };
        Ok(Self {
            codex_home,
            client: network::build_client()?,
            login: LoginCoordinator::default(),
            registry_lock: Mutex::new(()),
            watcher: Mutex::new(None),
        })
    }
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        _ => "linux",
    }
}

fn ok_registry(registry: registry::Registry) -> Value {
    json!({ "ok": true, "registry": { "ok": true, "data": registry } })
}

fn failure(error: impl Into<String>) -> Value {
    json!({ "ok": false, "error": error.into() })
}

#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn get_registry(state: State<'_, AppState>) -> Value {
    registry::registry_result(&state.codex_home)
}

#[tauri::command]
async fn get_announcements(app: AppHandle, opts: Option<Value>) -> Value {
    let state = app.state::<AppState>();
    network::get_announcements(
        &state.client,
        opts.unwrap_or_else(|| json!({})),
        platform_name(),
        &app.package_info().version.to_string(),
    )
    .await
}

fn open_url(app: &AppHandle, raw_url: &str) -> Result<(), String> {
    let parsed =
        url::Url::parse(raw_url).map_err(|_| "The link is not a valid web URL.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("The link is not a valid web URL.".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_announcement_url(app: AppHandle, url: String) -> Value {
    match open_url(&app, &url) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => failure(error),
    }
}

#[tauri::command]
fn open_codex_download(app: AppHandle) -> Value {
    let url = match platform_name() {
        "darwin" => "https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg",
        "win32" => "https://get.microsoft.com/installer/download/9PLM9XGG6VKS?cid=website_cta_psi",
        _ => return failure("Codex download is available for macOS and Windows."),
    };
    match open_url(&app, url) {
        Ok(()) => json!({ "ok": true, "platform": platform_name() }),
        Err(error) => failure(format!("Could not open Codex download: {error}")),
    }
}

#[tauri::command]
fn switch_account(state: State<'_, AppState>, account_key: String) -> Value {
    let _guard = match state.registry_lock.lock() {
        Ok(guard) => guard,
        Err(_) => return failure("Account storage is busy."),
    };
    match registry::switch_account(&state.codex_home, &account_key) {
        Ok(registry) => ok_registry(registry),
        Err(error) => failure(error),
    }
}

#[tauri::command]
async fn refresh_account_usage(app: AppHandle, account_key: String) -> Value {
    let state = app.state::<AppState>();
    let status =
        network::fetch_account_usage_status(&state.client, &state.codex_home, &account_key).await;
    if !status.ok {
        return json!({ "ok": false, "expired": status.expired, "error": status.error });
    }
    let mut usages = HashMap::new();
    usages.insert(account_key, status.usage.unwrap_or(Value::Null));
    let _guard = match state.registry_lock.lock() {
        Ok(guard) => guard,
        Err(_) => return failure("Account storage is busy."),
    };
    match registry::persist_usages(&state.codex_home, usages) {
        Ok(registry) => json!({
            "ok": true,
            "expired": false,
            "registry": { "ok": true, "data": registry }
        }),
        Err(error) => failure(error),
    }
}

#[tauri::command]
async fn check_accounts(app: AppHandle) -> Value {
    let state = app.state::<AppState>();
    let registry = match registry::load_registry(&state.codex_home) {
        Ok(registry) => registry,
        Err(error) => return failure(error),
    };
    let targets = registry
        .accounts
        .iter()
        .filter(|account| !matches!(account.auth_mode.as_deref(), Some("apikey" | "provider")))
        .map(|account| account.account_key.clone())
        .collect::<Vec<_>>();
    let client = state.client.clone();
    let codex_home = state.codex_home.clone();
    let results = stream::iter(targets.clone())
        .map(|account_key| {
            let client = client.clone();
            let codex_home = codex_home.clone();
            async move {
                let status =
                    network::fetch_account_usage_status(&client, &codex_home, &account_key).await;
                (account_key, status)
            }
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
    let mut statuses = Map::new();
    let mut usages = HashMap::new();
    for (account_key, status) in results {
        statuses.insert(
            account_key.clone(),
            json!({ "ok": status.ok, "expired": status.expired, "error": status.error }),
        );
        if let Some(usage) = status.usage {
            usages.insert(account_key, usage);
        }
    }
    let _guard = match state.registry_lock.lock() {
        Ok(guard) => guard,
        Err(_) => return failure("Account storage is busy."),
    };
    let registry_result = match registry::persist_usages(&state.codex_home, usages) {
        Ok(registry) => json!({ "ok": true, "data": registry }),
        Err(_) => registry::registry_result(&state.codex_home),
    };
    json!({ "ok": true, "statuses": statuses, "registry": registry_result })
}

#[tauri::command]
async fn login_start(app: AppHandle) -> Value {
    let state = app.state::<AppState>();
    let outcome = oauth::browser_login(&state.client, &state.login, &app).await;
    match outcome {
        Ok(OAuthOutcome::Cancelled) => json!({ "ok": false, "cancelled": true }),
        Ok(OAuthOutcome::Tokens(tokens)) => {
            let _guard = match state.registry_lock.lock() {
                Ok(guard) => guard,
                Err(_) => return failure("Account storage is busy."),
            };
            match registry::persist_chatgpt_login(
                &state.codex_home,
                tokens.id_token,
                tokens.access_token,
                tokens.refresh_token,
            ) {
                Ok((registry, _)) => ok_registry(registry),
                Err(error) => failure(error),
            }
        }
        Err(error) => failure(error),
    }
}

#[tauri::command]
fn login_cancel(state: State<'_, AppState>) -> Value {
    json!({ "ok": state.login.cancel() })
}

#[tauri::command]
async fn test_api_endpoint(app: AppHandle, opts: Option<TestApiOptions>) -> Value {
    let state = app.state::<AppState>();
    network::test_api_endpoint(
        &state.client,
        opts.unwrap_or(TestApiOptions {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
        }),
    )
    .await
}

#[tauri::command]
async fn test_provider_account(app: AppHandle, account_key: String) -> Value {
    let state = app.state::<AppState>();
    let options = match registry::provider_test_options(&state.codex_home, &account_key) {
        Ok(options) => options,
        Err(error) => return failure(error),
    };
    network::test_api_endpoint(
        &state.client,
        TestApiOptions {
            base_url: options.base_url,
            api_key: options.api_key,
            model: options.model,
        },
    )
    .await
}

#[tauri::command]
fn login_api(state: State<'_, AppState>, opts: Option<AddProviderOptions>) -> Value {
    let Some(options) = opts else {
        return failure("Endpoint URL and API key are required.");
    };
    if options.base_url.trim().is_empty() || options.api_key.trim().is_empty() {
        return failure("Endpoint URL and API key are required.");
    }
    let _guard = match state.registry_lock.lock() {
        Ok(guard) => guard,
        Err(_) => return failure("Account storage is busy."),
    };
    match registry::add_provider_account(&state.codex_home, options) {
        Ok(registry) => ok_registry(registry),
        Err(error) => failure(error),
    }
}

#[tauri::command]
fn remove_account(state: State<'_, AppState>, account_key: String) -> Value {
    let _guard = match state.registry_lock.lock() {
        Ok(guard) => guard,
        Err(_) => return failure("Account storage is busy."),
    };
    match registry::remove_account(&state.codex_home, &account_key) {
        Ok(registry) => ok_registry(registry),
        Err(error) => failure(error),
    }
}

fn export_account_key(opts: &Value) -> Option<String> {
    if let Some(value) = opts.as_str() {
        return (!value.trim().is_empty()).then(|| value.trim().to_string());
    }
    opts.get("accountKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn export_slug(value: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;
    for character in value.chars() {
        let normalized =
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '-'
            };
        if normalized == '-' && previous_dash {
            continue;
        }
        previous_dash = normalized == '-';
        output.push(normalized);
        if output.len() >= 60 {
            break;
        }
    }
    let trimmed = output.trim_matches('-');
    if trimmed.is_empty() {
        "account".into()
    } else {
        trimmed.into()
    }
}

#[tauri::command]
async fn export_accounts(app: AppHandle, opts: Option<Value>) -> Value {
    let state = app.state::<AppState>();
    let opts = opts.unwrap_or_else(|| json!({}));
    let account_key = export_account_key(&opts);
    let (payload, exported, missing, scope) =
        match registry::build_export_payload(&state.codex_home, account_key.as_deref()) {
            Ok(result) => result,
            Err(error) => return failure(error),
        };
    if exported == 0 {
        return failure(if account_key.is_some() {
            "No usable auth data found for this account."
        } else {
            "No accounts had usable auth data to export."
        });
    }
    let label = account_key
        .as_deref()
        .and_then(|key| registry::account_label(&state.codex_home, key))
        .unwrap_or_else(|| "accounts".into());
    let stamp = Utc::now().format("%Y%m%d");
    let file_name = if scope == "single" {
        format!("codex-auth-account-{}-{stamp}.json", export_slug(&label))
    } else {
        format!("codex-auth-accounts-{stamp}.json")
    };
    let dialog = app
        .dialog()
        .file()
        .set_title(if scope == "single" {
            "Export account"
        } else {
            "Export accounts"
        })
        .set_file_name(file_name)
        .add_filter("JSON", &["json"]);
    let Some(file_path) = dialog.blocking_save_file() else {
        return json!({ "ok": false, "cancelled": true });
    };
    let file_path = match file_path.into_path() {
        Ok(path) => path,
        Err(error) => return failure(format!("Invalid export path: {error}")),
    };
    let mut serialized = match serde_json::to_string_pretty(&payload) {
        Ok(value) => value,
        Err(error) => return failure(error.to_string()),
    };
    serialized.push('\n');
    if let Err(error) = registry::write_private_file(&file_path, serialized) {
        return failure(format!("Failed to write export file: {error}"));
    }
    json!({
        "ok": true,
        "path": file_path,
        "exported": exported,
        "missing": missing,
        "scope": scope
    })
}

#[tauri::command]
async fn export_accounts_share(app: AppHandle, opts: Option<Value>) -> Value {
    let state = app.state::<AppState>();
    let opts = opts.unwrap_or_else(|| json!({}));
    let account_key = export_account_key(&opts);
    let (payload, exported, missing, scope) =
        match registry::build_export_payload(&state.codex_home, account_key.as_deref()) {
            Ok(result) => result,
            Err(error) => return failure(error),
        };
    if exported == 0 {
        return failure(if account_key.is_some() {
            "No usable auth data found for this account."
        } else {
            "No accounts had usable auth data to export."
        });
    }
    let uploaded = network::upload_share(
        &state.client,
        payload,
        &opts,
        &app.package_info().version.to_string(),
    )
    .await;
    if uploaded.get("ok").and_then(Value::as_bool) != Some(true) {
        return uploaded;
    }
    json!({
        "ok": true,
        "shareUrl": uploaded.get("shareUrl"),
        "importUrl": uploaded.get("importUrl"),
        "expiresAt": uploaded.get("expiresAt"),
        "exported": exported,
        "missing": missing,
        "scope": scope
    })
}

fn wrap_import_result(mut result: Value, codex_home: &Path) -> Value {
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        result["registry"] = registry::registry_result(codex_home);
    }
    result
}

#[tauri::command]
async fn import_accounts(app: AppHandle) -> Value {
    let state = app.state::<AppState>();
    let Some(file_path) = app
        .dialog()
        .file()
        .set_title("Import accounts")
        .add_filter("JSON", &["json"])
        .blocking_pick_file()
    else {
        return json!({ "ok": false, "cancelled": true });
    };
    let file_path = match file_path.into_path() {
        Ok(path) => path,
        Err(error) => return failure(format!("Invalid import path: {error}")),
    };
    let payload = match fs::read_to_string(&file_path)
        .map_err(|error| error.to_string())
        .and_then(|content| {
            serde_json::from_str::<Value>(&content).map_err(|error| error.to_string())
        }) {
        Ok(payload) => payload,
        Err(error) => return failure(format!("Cannot read the file: {error}")),
    };
    let _guard = match state.registry_lock.lock() {
        Ok(guard) => guard,
        Err(_) => return failure("Account storage is busy."),
    };
    wrap_import_result(
        registry::import_payload(&state.codex_home, payload),
        &state.codex_home,
    )
}

#[tauri::command]
async fn import_accounts_from_url(app: AppHandle, opts: Option<Value>) -> Value {
    let state = app.state::<AppState>();
    let raw_url = opts
        .as_ref()
        .and_then(|opts| opts.get("url"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let fetched = network::fetch_share_export(&state.client, raw_url).await;
    if fetched.get("ok").and_then(Value::as_bool) != Some(true) {
        return fetched;
    }
    let payload = fetched.get("payload").cloned().unwrap_or(Value::Null);
    let _guard = match state.registry_lock.lock() {
        Ok(guard) => guard,
        Err(_) => return failure("Account storage is busy."),
    };
    wrap_import_result(
        registry::import_payload(&state.codex_home, payload),
        &state.codex_home,
    )
}

fn start_registry_watcher(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let directory = registry::accounts_dir(&state.codex_home);
    registry::ensure_accounts_directory(&state.codex_home).map_err(|error| error.to_string())?;
    let app_handle = app.clone();
    let codex_home = state.codex_home.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else {
            return;
        };
        if event
            .paths
            .iter()
            .any(|path| path.file_name().is_some_and(|name| name == "registry.json"))
        {
            let _ = app_handle.emit("registry-changed", registry::registry_result(&codex_home));
        }
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&directory, RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;
    let mut slot = state
        .watcher
        .lock()
        .map_err(|_| "File watcher state is unavailable.".to_string())?;
    *slot = Some(watcher);
    Ok(())
}

pub fn run() {
    let state = AppState::new().expect("failed to initialize the desktop application");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .setup(|app| {
            let state = app.state::<AppState>();
            let _ = registry::sync_active_provider_config(&state.codex_home);
            start_registry_watcher(app.handle(), &state)
                .map_err(Box::<dyn std::error::Error>::from)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_registry,
            get_announcements,
            open_announcement_url,
            open_codex_download,
            switch_account,
            check_accounts,
            refresh_account_usage,
            login_start,
            login_cancel,
            test_api_endpoint,
            test_provider_account,
            login_api,
            remove_account,
            export_accounts,
            export_accounts_share,
            import_accounts,
            import_accounts_from_url,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the desktop application");
}
