mod network;
mod oauth;
mod registry;

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
        let codex_home = codex_home_directory()
            .ok_or_else(|| "Could not determine the current user's home directory.".to_string())?;
        Ok(Self {
            codex_home,
            client: network::build_client()?,
            login: LoginCoordinator::default(),
            registry_lock: Mutex::new(()),
            watcher: Mutex::new(None),
        })
    }
}

fn non_empty_path(value: Option<OsString>) -> Option<OsString> {
    value.filter(|path| !path.is_empty())
}

fn select_home_directory(
    home: Option<OsString>,
    user_profile: Option<OsString>,
    windows: bool,
) -> Option<PathBuf> {
    let home = non_empty_path(home).map(PathBuf::from);
    let user_profile = non_empty_path(user_profile).map(PathBuf::from);
    if windows {
        user_profile.or(home)
    } else {
        home.or(user_profile)
    }
}

fn has_account_data(codex_home: &Path) -> bool {
    if codex_home.join("auth.json").is_file() {
        return true;
    }
    if let Ok(content) = fs::read_to_string(codex_home.join("accounts/registry.json")) {
        match serde_json::from_str::<Value>(&content) {
            Ok(value) => {
                if value
                    .get("accounts")
                    .and_then(Value::as_array)
                    .is_some_and(|accounts| !accounts.is_empty())
                    || value
                        .get("active_account_key")
                        .is_some_and(|key| !key.is_null())
                {
                    return true;
                }
            }
            Err(_) => return true,
        }
    }
    fs::read_dir(codex_home.join("accounts"))
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().ends_with(".auth.json"))
}

fn select_codex_home(
    explicit: Option<OsString>,
    home: Option<OsString>,
    user_profile: Option<OsString>,
    windows: bool,
) -> Option<PathBuf> {
    if let Some(explicit) = non_empty_path(explicit) {
        return Some(PathBuf::from(explicit));
    }
    let home = non_empty_path(home);
    let user_profile = non_empty_path(user_profile);
    let preferred_root = select_home_directory(home.clone(), user_profile, windows)?;
    let preferred = preferred_root.join(".codex");
    if windows {
        if let Some(legacy) = home.map(PathBuf::from).map(|path| path.join(".codex")) {
            if legacy != preferred && !has_account_data(&preferred) && has_account_data(&legacy) {
                return Some(legacy);
            }
        }
    }
    Some(preferred)
}

fn codex_home_directory() -> Option<PathBuf> {
    select_codex_home(
        std::env::var_os("CODEX_HOME"),
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
        cfg!(windows),
    )
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
        Ok(OAuthOutcome::Authorized { tokens, responder }) => {
            let persisted: Result<registry::Registry, String> = (|| {
                let _guard = state
                    .registry_lock
                    .lock()
                    .map_err(|_| "Account storage is busy.".to_string())?;
                registry::persist_chatgpt_login(
                    &state.codex_home,
                    tokens.id_token,
                    tokens.access_token,
                    tokens.refresh_token,
                )
                .map(|(registry, _)| registry)
            })();
            match persisted {
                Ok(registry) => {
                    responder.success().await;
                    ok_registry(registry)
                }
                Err(error) => {
                    responder.failure(&error).await;
                    failure(error)
                }
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
    let event_generation = Arc::new(AtomicU64::new(0));
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else {
            return;
        };
        if event
            .paths
            .iter()
            .any(|path| path.file_name().is_some_and(|name| name == "registry.json"))
        {
            let generation = event_generation.fetch_add(1, Ordering::SeqCst) + 1;
            let event_generation = Arc::clone(&event_generation);
            let app_handle = app_handle.clone();
            let codex_home = codex_home.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if event_generation.load(Ordering::SeqCst) == generation {
                    let _ =
                        app_handle.emit("registry-changed", registry::registry_result(&codex_home));
                }
            });
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
            let _ = registry::repair_registry_from_auth_files(&state.codex_home);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_home_prefers_user_profile() {
        assert_eq!(
            select_home_directory(
                Some(OsString::from(r"C:\tools\home")),
                Some(OsString::from(r"C:\Users\person")),
                true,
            ),
            Some(PathBuf::from(r"C:\Users\person"))
        );
    }

    #[test]
    fn empty_home_values_are_ignored() {
        assert_eq!(
            select_home_directory(
                Some(OsString::new()),
                Some(OsString::from(r"C:\Users\person")),
                false,
            ),
            Some(PathBuf::from(r"C:\Users\person"))
        );
        assert_eq!(
            select_home_directory(Some(OsString::new()), Some(OsString::new()), true),
            None
        );
    }

    #[test]
    fn non_windows_home_prefers_home() {
        assert_eq!(
            select_home_directory(
                Some(OsString::from("/home/person")),
                Some(OsString::from("/fallback/person")),
                false,
            ),
            Some(PathBuf::from("/home/person"))
        );
    }

    #[test]
    fn windows_upgrade_uses_legacy_home_only_when_canonical_store_is_empty() {
        let root = std::env::temp_dir().join(format!(
            "codex-auth-tauri-home-selection-{}",
            uuid::Uuid::new_v4()
        ));
        let legacy_root = root.join("legacy");
        let profile_root = root.join("profile");
        fs::create_dir_all(legacy_root.join(".codex")).unwrap();
        fs::write(legacy_root.join(".codex/auth.json"), "{}\n").unwrap();

        assert_eq!(
            select_codex_home(
                None,
                Some(legacy_root.clone().into_os_string()),
                Some(profile_root.clone().into_os_string()),
                true,
            ),
            Some(legacy_root.join(".codex"))
        );

        fs::create_dir_all(profile_root.join(".codex/accounts")).unwrap();
        fs::write(
            profile_root.join(".codex/accounts/registry.json"),
            r#"{"accounts":[{"account_key":"canonical"}]}"#,
        )
        .unwrap();
        assert_eq!(
            select_codex_home(
                None,
                Some(legacy_root.into_os_string()),
                Some(profile_root.clone().into_os_string()),
                true,
            ),
            Some(profile_root.join(".codex"))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[ignore = "requires CODEX_AUTH_TEST_SHARE_URL and network access"]
    async fn live_share_link_downloads_imports_and_reloads() {
        let share_url = std::env::var("CODEX_AUTH_TEST_SHARE_URL")
            .expect("CODEX_AUTH_TEST_SHARE_URL must be set for this ignored test");
        let client = network::build_client().unwrap();
        let fetched = network::fetch_share_export(&client, &share_url).await;
        assert_eq!(
            fetched.get("ok").and_then(Value::as_bool),
            Some(true),
            "{}",
            fetched
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Share download failed without an error message.")
        );
        let payload = fetched.get("payload").cloned().unwrap();
        let home = std::env::temp_dir().join(format!(
            "codex-auth-tauri-live-share-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(home.join("accounts")).unwrap();
        fs::write(
            home.join("accounts/registry.json"),
            serde_json::to_vec_pretty(&json!({
                "schema_version": 5,
                "accounts": [{
                    "account_key": "legacy-provider",
                    "chatgpt_account_id": "",
                    "chatgpt_user_id": "",
                    "email": "",
                    "alias": "",
                    "auth_mode": "provider",
                    "provider": {
                        "id": "legacy-provider",
                        "base_url": "https://provider.example.com/v1",
                        "model": null
                    }
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            registry::account_auth_path(&home, "legacy-provider"),
            b"{\"OPENAI_API_KEY\":\"sk-fixture\"}\n",
        )
        .unwrap();
        assert!(registry::load_registry(&home).is_ok());
        let imported = registry::import_payload(&home, payload);
        assert_eq!(
            imported.get("ok").and_then(Value::as_bool),
            Some(true),
            "{}",
            imported
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Share import failed without an error message.")
        );

        let registry = registry::load_registry(&home).unwrap();
        assert!(registry.accounts.len() > 1);
        assert!(registry
            .accounts
            .iter()
            .any(|account| account.account_key == "legacy-provider"));
        for account in &registry.accounts {
            assert!(registry::account_auth_path(&home, &account.account_key).exists());
        }
        let reloaded = registry::registry_result(&home);
        assert_eq!(reloaded.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            reloaded
                .pointer("/data/accounts")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(registry.accounts.len())
        );
        let _ = fs::remove_dir_all(home);
    }
}
