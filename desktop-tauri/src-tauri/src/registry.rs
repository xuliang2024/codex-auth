use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chrono::{Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest as _, Sha256};

pub const CURRENT_SCHEMA_VERSION: u32 = 5;
pub const DEFAULT_PROVIDER_MODEL: &str = "gpt-5.6-sol";
pub const DEFAULT_PROVIDER_REASONING_EFFORT: &str = "medium";

const MAX_BACKUPS: usize = 5;
const HEAD_BEGIN: &str = "# >>> codex-auth provider (do not edit) >>>";
const HEAD_END: &str = "# <<< codex-auth provider <<<";
const TAIL_BEGIN: &str = "# >>> codex-auth provider tables (do not edit) >>>";
const TAIL_END: &str = "# <<< codex-auth provider tables <<<";
const DISABLED_PREFIX: &str = "#codex-auth:disabled# ";
const INCOMPATIBLE_PREFIX: &str = "#codex-auth:incompatible# ";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registry {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub active_account_key: Option<String>,
    #[serde(default)]
    pub previous_active_account_key: Option<String>,
    #[serde(default)]
    pub active_account_activated_at_ms: Option<i64>,
    #[serde(default = "default_interval")]
    pub interval_seconds: u64,
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub account_key: String,
    #[serde(default, deserialize_with = "deserialize_string_or_default")]
    pub chatgpt_account_id: String,
    #[serde(default, deserialize_with = "deserialize_string_or_default")]
    pub chatgpt_user_id: String,
    #[serde(default, deserialize_with = "deserialize_string_or_default")]
    pub email: String,
    #[serde(default, deserialize_with = "deserialize_string_or_default")]
    pub alias: String,
    #[serde(default)]
    pub account_name: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub auth_mode: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub last_usage: Option<Value>,
    #[serde(default)]
    pub last_usage_at: Option<i64>,
    #[serde(default)]
    pub last_local_rollout: Option<Value>,
    #[serde(default)]
    pub provider: Option<Provider>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub base_url: String,
    #[serde(default, deserialize_with = "deserialize_string_or_default")]
    pub model: String,
    #[serde(default)]
    pub model_reasoning_effort: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub struct ChatgptIdentity {
    pub email: Option<String>,
    pub account_id: String,
    pub user_id: String,
    pub record_key: String,
    pub plan: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProviderOptions {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub provider_kind: String,
    #[serde(default, deserialize_with = "deserialize_reasoning_effort")]
    pub reasoning_effort: ReasoningEffort,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProviderOptions {
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub enum ReasoningEffort {
    #[default]
    Missing,
    Null,
    Value(String),
}

fn deserialize_string_or_default<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

fn deserialize_reasoning_effort<'de, D>(deserializer: D) -> Result<ReasoningEffort, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match Option::<String>::deserialize(deserializer)? {
        Some(value) => ReasoningEffort::Value(value),
        None => ReasoningEffort::Null,
    })
}

#[derive(Debug, Clone)]
pub struct ProviderTestOptions {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

fn schema_version() -> u32 {
    CURRENT_SCHEMA_VERSION
}

fn default_interval() -> u64 {
    60
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            active_account_key: None,
            previous_active_account_key: None,
            active_account_activated_at_ms: None,
            interval_seconds: default_interval(),
            accounts: Vec::new(),
            extra: Map::new(),
        }
    }
}

pub fn accounts_dir(codex_home: &Path) -> PathBuf {
    codex_home.join("accounts")
}

pub fn registry_path(codex_home: &Path) -> PathBuf {
    accounts_dir(codex_home).join("registry.json")
}

pub fn active_auth_path(codex_home: &Path) -> PathBuf {
    codex_home.join("auth.json")
}

fn key_needs_filename_encoding(key: &str) -> bool {
    key.is_empty()
        || matches!(key, "." | "..")
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub fn account_auth_path(codex_home: &Path, account_key: &str) -> PathBuf {
    let file_key = if key_needs_filename_encoding(account_key) {
        URL_SAFE_NO_PAD.encode(account_key.as_bytes())
    } else {
        account_key.to_string()
    };
    accounts_dir(codex_home).join(format!("{file_key}.auth.json"))
}

fn ensure_accounts_dir(codex_home: &Path) -> io::Result<()> {
    let directory = accounts_dir(codex_home);
    fs::create_dir_all(&directory)?;
    set_mode(&directory, 0o700)
}

pub fn ensure_accounts_directory(codex_home: &Path) -> io::Result<()> {
    ensure_accounts_dir(codex_home)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

pub fn write_private_file(path: &Path, content: impl AsRef<[u8]>) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    set_mode(path, 0o600)
}

fn remove_file_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn backup_timestamp() -> String {
    Local::now().format("%Y%m%d-%H%M%S").to_string()
}

fn make_backup_path(directory: &Path, base_name: &str) -> PathBuf {
    let base = format!("{base_name}.bak.{}", backup_timestamp());
    for attempt in 0_u32.. {
        let name = if attempt == 0 {
            base.clone()
        } else {
            format!("{base}.{attempt}")
        };
        let candidate = directory.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn prune_backups(directory: &Path, base_name: &str) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut backups = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with(base_name) || !name.contains(".bak.") {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in backups.into_iter().skip(MAX_BACKUPS) {
        let _ = fs::remove_file(path);
    }
}

fn backup_file_if_changed(
    codex_home: &Path,
    file_path: &Path,
    base_name: &str,
    new_content: Option<&str>,
) -> io::Result<()> {
    if !file_path.exists() {
        return Ok(());
    }
    if let Some(expected) = new_content {
        if fs::read_to_string(file_path).ok().as_deref() == Some(expected) {
            return Ok(());
        }
    }
    ensure_accounts_dir(codex_home)?;
    let directory = accounts_dir(codex_home);
    let backup = make_backup_path(&directory, base_name);
    fs::copy(file_path, &backup)?;
    set_mode(&backup, 0o600)?;
    prune_backups(&directory, base_name);
    Ok(())
}

fn parse_registry_content(content: &str) -> Result<Registry, String> {
    let value = serde_json::from_str::<Value>(content).map_err(|error| error.to_string())?;
    if let Some(version) = value.get("schema_version").and_then(Value::as_u64) {
        if version > u64::from(CURRENT_SCHEMA_VERSION) {
            return Err(format!(
                "Registry schema version {version} is not supported by this app (supports up to {CURRENT_SCHEMA_VERSION})."
            ));
        }
    }
    serde_json::from_value::<Registry>(value).map_err(|error| error.to_string())
}

pub fn load_registry(codex_home: &Path) -> Result<Registry, String> {
    match fs::read_to_string(registry_path(codex_home)) {
        Ok(content) => parse_registry_content(&content).map_err(|error| {
            if error.starts_with("Registry schema version ") {
                error
            } else {
                format!("Failed to parse registry.json: {error}")
            }
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Registry::default()),
        Err(error) => Err(format!("Failed to read registry.json: {error}")),
    }
}

pub fn registry_result(codex_home: &Path) -> Value {
    match load_registry(codex_home) {
        Ok(registry) => json!({ "ok": true, "data": registry }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn merge_chatgpt_auth(registry: &mut Registry, auth: &Value) -> Option<(String, bool)> {
    let identity = parse_chatgpt_identity(auth)?;
    let key = identity.record_key.clone();
    let mut changed = false;
    if let Some(index) = find_account_index(registry, &key) {
        let account = &mut registry.accounts[index];
        if account.chatgpt_account_id.is_empty() {
            account.chatgpt_account_id = identity.account_id;
            changed = true;
        }
        if account.chatgpt_user_id.is_empty() {
            account.chatgpt_user_id = identity.user_id;
            changed = true;
        }
        if account.email.is_empty() {
            if let Some(email) = identity.email {
                account.email = email;
                changed = true;
            }
        }
        if account.plan.is_none() && identity.plan.is_some() {
            account.plan = identity.plan;
            changed = true;
        }
        if account.auth_mode.is_none() {
            account.auth_mode = Some("chatgpt".to_string());
            changed = true;
        }
    } else {
        registry.accounts.push(Account {
            chatgpt_account_id: identity.account_id,
            chatgpt_user_id: identity.user_id,
            email: identity.email.unwrap_or_default(),
            plan: identity.plan,
            ..base_account(key.clone(), "chatgpt", None)
        });
        changed = true;
    }
    Some((key, changed))
}

fn recover_active_chatgpt_account(codex_home: &Path, registry: &mut Registry) -> bool {
    let mut changed = false;
    if let Some(auth) = read_auth_value(&active_auth_path(codex_home)) {
        if let Some((active_key, merged)) = merge_chatgpt_auth(registry, &auth) {
            changed |= merged;
            if registry.active_account_key.as_deref() != Some(active_key.as_str()) {
                set_active_account_key(registry, &active_key, false);
                changed = true;
            }
        }
    }
    changed
}

fn latest_valid_registry_backup(codex_home: &Path) -> Option<Registry> {
    let mut backups = fs::read_dir(accounts_dir(codex_home))
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("registry.json.bak.") {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.0.cmp(&left.0));
    backups.into_iter().find_map(|(_, path)| {
        let content = fs::read_to_string(path).ok()?;
        parse_registry_content(&content).ok()
    })
}

fn load_registry_with_repair(codex_home: &Path) -> Result<(Registry, bool), String> {
    let (mut registry, restored_backup) = match load_registry(codex_home) {
        Ok(registry) => (registry, false),
        Err(error) if error.starts_with("Failed to parse registry.json:") => {
            let path = registry_path(codex_home);
            backup_file_if_changed(codex_home, &path, "registry.json", None).map_err(
                |backup_error| {
                    format!("{error}. The damaged registry could not be backed up: {backup_error}")
                },
            )?;
            let registry = latest_valid_registry_backup(codex_home).ok_or_else(|| {
                format!(
                    "{error}. The damaged registry was backed up, but no valid registry backup was available. The original account index was not replaced."
                )
            })?;
            (registry, true)
        }
        Err(error) => return Err(error),
    };
    let recovered_active = recover_active_chatgpt_account(codex_home, &mut registry);
    Ok((registry, restored_backup || recovered_active))
}

fn load_registry_for_update(codex_home: &Path) -> Result<Registry, String> {
    load_registry_with_repair(codex_home).map(|(registry, _)| registry)
}

pub fn repair_registry_from_auth_files(codex_home: &Path) -> Result<Registry, String> {
    let (mut registry, changed) = load_registry_with_repair(codex_home)?;
    if changed {
        save_registry(codex_home, &mut registry)?;
    }
    Ok(registry)
}

pub fn save_registry(codex_home: &Path, registry: &mut Registry) -> Result<(), String> {
    registry.schema_version = CURRENT_SCHEMA_VERSION;
    ensure_accounts_dir(codex_home).map_err(|error| error.to_string())?;
    let mut data = serde_json::to_string_pretty(registry).map_err(|error| error.to_string())?;
    data.push('\n');
    let path = registry_path(codex_home);
    if fs::read_to_string(&path).ok().as_deref() == Some(data.as_str()) {
        set_mode(&path, 0o600).map_err(|error| error.to_string())?;
        return Ok(());
    }
    backup_file_if_changed(codex_home, &path, "registry.json", Some(&data))
        .map_err(|error| error.to_string())?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temporary = path.with_extension(format!("json.tmp.{}.{millis}", std::process::id()));
    write_private_file(&temporary, data).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn now_seconds() -> i64 {
    Utc::now().timestamp()
}

fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

fn find_account_index(registry: &Registry, account_key: &str) -> Option<usize> {
    registry
        .accounts
        .iter()
        .position(|account| account.account_key == account_key)
}

fn set_active_account_key(registry: &mut Registry, account_key: &str, preserve_previous: bool) {
    if registry.active_account_key.as_deref() == Some(account_key) {
        return;
    }
    if !preserve_previous {
        registry.previous_active_account_key = registry
            .active_account_key
            .as_ref()
            .filter(|key| find_account_index(registry, key).is_some())
            .cloned();
    }
    registry.active_account_key = Some(account_key.to_string());
    registry.active_account_activated_at_ms = Some(now_millis());
    if let Some(account) = registry
        .accounts
        .iter_mut()
        .find(|account| account.account_key == account_key)
    {
        account.last_used_at = Some(now_seconds());
    }
}

fn decode_jwt_claims(token: &str) -> Option<Value> {
    let encoded = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .or_else(|_| URL_SAFE.decode(encoded))
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn ensure_chatgpt_refresh_metadata(auth: &mut Value) -> bool {
    if auth.get("auth_mode").and_then(Value::as_str) != Some("chatgpt")
        || auth
            .get("last_refresh")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    {
        return false;
    }
    let refreshed_at = auth
        .pointer("/tokens/access_token")
        .and_then(Value::as_str)
        .and_then(decode_jwt_claims)
        .and_then(|claims| claims.get("iat").and_then(Value::as_i64))
        .and_then(|timestamp| chrono::DateTime::<Utc>::from_timestamp(timestamp, 0))
        .map(|timestamp| timestamp.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    auth["last_refresh"] = Value::String(refreshed_at);
    true
}

pub fn parse_chatgpt_identity(auth: &Value) -> Option<ChatgptIdentity> {
    let id_token = auth.pointer("/tokens/id_token")?.as_str()?;
    let claims = decode_jwt_claims(id_token)?;
    let auth_claims = claims
        .get("https://api.openai.com/auth")
        .and_then(Value::as_object);

    let mut account_id = auth
        .pointer("/tokens/account_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    if account_id.is_none() {
        account_id = auth_claims
            .and_then(|value| value.get("chatgpt_account_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
    }
    if account_id.is_none() {
        let organizations = auth_claims
            .and_then(|value| value.get("organizations"))
            .and_then(Value::as_array)?;
        account_id = organizations
            .iter()
            .find(|organization| {
                organization.get("is_default").and_then(Value::as_bool) == Some(true)
            })
            .or_else(|| organizations.first())
            .and_then(|organization| organization.get("id"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
    }

    let user_id = auth_claims
        .and_then(|value| {
            value
                .get("chatgpt_user_id")
                .or_else(|| value.get("user_id"))
        })
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?
        .to_string();
    let account_id = account_id?;
    let email = claims
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_lowercase);
    let known_plans = [
        "free",
        "go",
        "plus",
        "prolite",
        "pro",
        "team",
        "business",
        "enterprise",
        "edu",
    ];
    let plan = auth_claims
        .and_then(|value| value.get("chatgpt_plan_type"))
        .and_then(Value::as_str)
        .map(str::to_lowercase)
        .map(|value| {
            if known_plans.contains(&value.as_str()) {
                value
            } else {
                "unknown".into()
            }
        });

    Some(ChatgptIdentity {
        email,
        record_key: format!("{user_id}::{account_id}"),
        account_id,
        user_id,
        plan,
    })
}

fn sha256_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn provider_account_key(host: &str, api_key: &str) -> String {
    format!("provider::{host}::{}", sha256_hex(api_key))
}

fn api_key_account_name(api_key: &str) -> String {
    let hash = sha256_hex(api_key);
    format!("sk-{}***{}", &hash[..5], &hash[hash.len() - 4..])
}

pub fn normalize_provider_base_url(raw: &str) -> Option<String> {
    let mut value = raw.trim().trim_end_matches('/').to_string();
    if !value.starts_with("https://") && !value.starts_with("http://") {
        return None;
    }
    if value.to_lowercase().ends_with("/responses") {
        let new_length = value.len() - "/responses".len();
        value.truncate(new_length);
        value = value.trim_end_matches('/').to_string();
    }
    let parsed = url::Url::parse(&value).ok()?;
    parsed.host_str()?;
    Some(value)
}

fn provider_host(base_url: &str) -> Option<String> {
    let parsed = url::Url::parse(base_url).ok()?;
    let host = parsed.host_str()?;
    Some(match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

fn sanitize_provider_id(raw: &str) -> Option<String> {
    let mut output = String::new();
    for character in raw.chars() {
        if character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '_' | '-')
        {
            output.push(character);
        } else if character.is_ascii_uppercase() {
            output.push(character.to_ascii_lowercase());
        } else if matches!(character, '.' | ':') {
            output.push('-');
        }
    }
    (!output.is_empty()).then_some(output)
}

fn is_volcengine_ark_provider(provider: &Provider) -> bool {
    provider.id.eq_ignore_ascii_case("volcengine-ark")
        || provider.id.eq_ignore_ascii_case("doubao")
        || provider
            .base_url
            .to_lowercase()
            .contains(".volces.com/api/v3")
}

fn is_byteplus_provider(provider: &Provider) -> bool {
    provider.id.eq_ignore_ascii_case("byteplus-ark")
        || provider
            .base_url
            .to_lowercase()
            .contains(".bytepluses.com/api/v3")
        || is_volcengine_ark_provider(provider)
}

fn is_claude_provider(provider: &Provider) -> bool {
    provider.id.to_lowercase().contains("claude")
        || provider.model.to_lowercase().starts_with("claude-")
}

fn is_likely_openai_model(model: &str) -> bool {
    let model = model.trim().to_lowercase();
    [
        "gpt-",
        "o1",
        "o3",
        "o4",
        "codex-",
        "chatgpt-",
        "computer-use-",
    ]
    .iter()
    .any(|prefix| model.starts_with(prefix))
}

fn provider_needs_model_catalog(provider: &Provider) -> bool {
    !provider.model.trim().is_empty()
        && (is_byteplus_provider(provider)
            || is_claude_provider(provider)
            || !is_likely_openai_model(&provider.model))
}

pub fn is_native_anthropic_base_url(raw: &str) -> bool {
    url::Url::parse(raw.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_lowercase))
        .as_deref()
        == Some("api.anthropic.com")
}

fn provider_display_name(provider: &Provider) -> String {
    if is_volcengine_ark_provider(provider) {
        "Volcengine Ark".to_string()
    } else if is_byteplus_provider(provider) {
        "BytePlus Ark".to_string()
    } else if is_claude_provider(provider) {
        "Claude via Responses".to_string()
    } else if provider.id.eq_ignore_ascii_case("apiz") {
        "APIZ".to_string()
    } else {
        provider.id.clone()
    }
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn marker_line(line: &str, marker: &str) -> bool {
    line.trim() == marker
}

fn strip_managed_regions(content: &str) -> Option<String> {
    let mut output = Vec::new();
    let mut end_marker: Option<&str> = None;
    let mut removed = false;
    for line in content.split('\n') {
        if let Some(end) = end_marker {
            if marker_line(line, end) {
                end_marker = None;
            }
            continue;
        }
        if marker_line(line, HEAD_BEGIN) {
            end_marker = Some(HEAD_END);
            removed = true;
        } else if marker_line(line, TAIL_BEGIN) {
            end_marker = Some(TAIL_END);
            removed = true;
        } else {
            output.push(line);
        }
    }
    removed.then(|| output.join("\n"))
}

fn top_level_key(line: &str) -> Option<&str> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') || line.starts_with('[') {
        return None;
    }
    Some(line.split_once('=')?.0.trim())
}

fn disable_conflicting_lines(content: &str) -> String {
    let managed = [
        "model_provider",
        "model",
        "review_model",
        "model_reasoning_effort",
        "model_catalog_json",
    ];
    let mut top_level = true;
    content
        .split('\n')
        .map(|line| {
            if line.trim().starts_with('[') {
                top_level = false;
            }
            let key = top_level.then(|| top_level_key(line)).flatten();
            match key {
                Some("model_provider") => format!("{INCOMPATIBLE_PREFIX}{line}"),
                Some(key) if managed.contains(&key) => format!("{DISABLED_PREFIX}{line}"),
                _ => line.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn restore_disabled_lines(content: &str) -> String {
    content
        .split('\n')
        .map(|line| line.strip_prefix(DISABLED_PREFIX).unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn quarantine_foreign_provider_lines(content: &str) -> Option<String> {
    let mut changed = false;
    let mut top_level = true;
    let output = content
        .split('\n')
        .map(|line| {
            if line.trim().starts_with('[') {
                top_level = false;
            }
            if top_level && top_level_key(line) == Some("model_provider") {
                changed = true;
                format!("{INCOMPATIBLE_PREFIX}{line}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    changed.then_some(output)
}

fn provider_head(provider: &Provider, provider_id: &str, catalog_path: Option<&Path>) -> String {
    let mut lines = vec![
        HEAD_BEGIN.to_string(),
        format!("model_provider = {}", toml_string(provider_id)),
    ];
    if !provider.model.is_empty() {
        lines.push(format!("model = {}", toml_string(&provider.model)));
        lines.push(format!("review_model = {}", toml_string(&provider.model)));
    }
    if !provider_needs_model_catalog(provider) {
        if let Some(effort) = provider
            .model_reasoning_effort
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("model_reasoning_effort = {}", toml_string(effort)));
        }
    }
    if let Some(path) = catalog_path {
        lines.push(format!(
            "model_catalog_json = {}",
            toml_string(&path.to_string_lossy())
        ));
    }
    lines.push(HEAD_END.to_string());
    lines.push(String::new());
    lines.join("\n")
}

fn provider_tail(provider: &Provider, provider_id: &str) -> String {
    [
        TAIL_BEGIN.to_string(),
        format!("[model_providers.{provider_id}]"),
        format!("name = {}", toml_string(&provider_display_name(provider))),
        format!("base_url = {}", toml_string(&provider.base_url)),
        "wire_api = \"responses\"".to_string(),
        "requires_openai_auth = true".to_string(),
        TAIL_END.to_string(),
        String::new(),
    ]
    .join("\n")
}

fn write_model_catalog(codex_home: &Path, provider: &Provider) -> Result<Option<PathBuf>, String> {
    if !provider_needs_model_catalog(provider) {
        return Ok(None);
    }
    let display_name = match provider.model.as_str() {
        "seed-2-0-lite-260228" | "seed-2-0-lite-260428" => "BytePlus Seed 2.0 Lite",
        "doubao-seed-2-0-lite-260215" => "Doubao Seed 2.0 Lite",
        _ => &provider.model,
    };
    let provider_name = provider_display_name(provider);
    let is_claude = is_claude_provider(provider);
    let catalog = json!({
        "models": [{
            "slug": provider.model,
            "display_name": display_name,
            "description": format!("{provider_name} model through a Responses-compatible endpoint."),
            "default_reasoning_level": null,
            "supported_reasoning_levels": [],
            "shell_type": "shell_command",
            "visibility": "list",
            "supported_in_api": true,
            "priority": 0,
            "additional_speed_tiers": [],
            "service_tiers": [],
            "availability_nux": null,
            "upgrade": null,
            "base_instructions": "You are Codex, a coding agent. Help the user understand and change code, use available tools carefully, and report results clearly.",
            "model_messages": {
                "instructions_template": "You are Codex, a coding agent. Help the user understand and change code, use available tools carefully, and report results clearly.",
                "instructions_variables": {
                    "personality_default": "",
                    "personality_friendly": "",
                    "personality_pragmatic": ""
                },
                "approvals": null
            },
            "supports_reasoning_summaries": false,
            "default_reasoning_summary": "none",
            "support_verbosity": false,
            "default_verbosity": "low",
            "apply_patch_tool_type": "freeform",
            "web_search_tool_type": "text_and_image",
            "truncation_policy": { "mode": "tokens", "limit": 10000 },
            "supports_parallel_tool_calls": !is_claude,
            "supports_image_detail_original": false,
            "context_window": 128000,
            "max_context_window": 128000,
            "effective_context_window_percent": 95,
            "experimental_supported_tools": [],
            "input_modalities": ["text"],
            "supports_search_tool": false,
            "use_responses_lite": false
        }]
    });
    let directory = accounts_dir(codex_home).join("model-catalogs");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    set_mode(&directory, 0o700).map_err(|error| error.to_string())?;
    let file_name = sanitize_provider_id(&provider.id).unwrap_or_else(|| "provider".into());
    let path = directory.join(format!("{file_name}.json"));
    let mut content = serde_json::to_string_pretty(&catalog).map_err(|error| error.to_string())?;
    content.push('\n');
    write_private_file(&path, content).map_err(|error| error.to_string())?;
    Ok(Some(path))
}

fn table_provider_id(line: &str) -> Option<&str> {
    let line = line.split('#').next()?.trim();
    line.strip_prefix("[model_providers.")?.strip_suffix(']')
}

fn has_model_provider_table(content: &str, provider_id: &str) -> bool {
    content
        .lines()
        .any(|line| table_provider_id(line) == Some(provider_id))
}

fn effective_provider_id(content: &str, provider_id: &str) -> String {
    let reserved = matches!(provider_id, "openai" | "ollama" | "lmstudio");
    if !reserved && !has_model_provider_table(content, provider_id) {
        return provider_id.to_string();
    }
    let base = format!("{provider_id}-codex-auth");
    if !has_model_provider_table(content, &base) {
        return base;
    }
    for index in 2.. {
        let candidate = format!("{base}-{index}");
        if !has_model_provider_table(content, &candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn apply_provider_blocks(content: &str, provider: &Provider, catalog: Option<&Path>) -> String {
    let stripped = strip_managed_regions(content).unwrap_or_else(|| content.to_string());
    let user = disable_conflicting_lines(&stripped);
    let provider_id = effective_provider_id(&user, &provider.id);
    let mut output = provider_head(provider, &provider_id, catalog);
    let trimmed = user.trim_matches('\n');
    if !trimmed.is_empty() {
        output.push('\n');
        output.push_str(trimmed);
        output.push('\n');
    }
    output.push('\n');
    output.push_str(&provider_tail(provider, &provider_id));
    output
}

fn remove_provider_blocks(content: &str) -> Option<String> {
    let stripped = strip_managed_regions(content);
    let had_regions = stripped.is_some();
    let had_disabled = content.contains(DISABLED_PREFIX);
    let restored = if had_regions || had_disabled {
        restore_disabled_lines(stripped.as_deref().unwrap_or(content))
    } else {
        content.to_string()
    };
    let quarantined = quarantine_foreign_provider_lines(&restored);
    if !had_regions && !had_disabled && quarantined.is_none() {
        return None;
    }
    let result = quarantined.unwrap_or(restored);
    let trimmed = result.trim_matches('\n');
    Some(if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}\n")
    })
}

fn sync_config_for_provider(codex_home: &Path, provider: Option<&Provider>) -> Result<(), String> {
    let path = codex_home.join("config.toml");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let new_content = match provider {
        Some(provider) => {
            let catalog = write_model_catalog(codex_home, provider)?;
            apply_provider_blocks(&existing, provider, catalog.as_deref())
        }
        None => {
            if !path.exists() {
                return Ok(());
            }
            let Some(content) = remove_provider_blocks(&existing) else {
                return Ok(());
            };
            content
        }
    };
    if new_content == existing {
        return Ok(());
    }
    backup_file_if_changed(codex_home, &path, "config.toml", Some(&new_content))
        .map_err(|error| error.to_string())?;
    fs::write(path, new_content).map_err(|error| error.to_string())
}

pub fn sync_active_provider_config(codex_home: &Path) -> Result<(), String> {
    let registry = load_registry(codex_home)?;
    let provider = registry
        .active_account_key
        .as_deref()
        .and_then(|key| {
            registry
                .accounts
                .iter()
                .find(|account| account.account_key == key)
        })
        .and_then(|account| account.provider.as_ref());
    if registry.active_account_key.is_some() {
        sync_config_for_provider(codex_home, provider)?;
    }
    Ok(())
}

fn activate_account(
    codex_home: &Path,
    registry: &mut Registry,
    account_key: &str,
) -> Result<(), String> {
    let index = find_account_index(registry, account_key)
        .ok_or_else(|| "Account not found in registry.".to_string())?;
    let source = account_auth_path(codex_home, account_key);
    if !source.exists() {
        return Err("Stored auth snapshot for this account is missing.".into());
    }
    let mut content = fs::read_to_string(&source).map_err(|error| error.to_string())?;
    if let Ok(mut auth) = serde_json::from_str::<Value>(&content) {
        if ensure_chatgpt_refresh_metadata(&mut auth) {
            content = serde_json::to_string_pretty(&auth).map_err(|error| error.to_string())?;
            content.push('\n');
            write_private_file(&source, &content).map_err(|error| error.to_string())?;
        }
    }
    let destination = active_auth_path(codex_home);
    backup_file_if_changed(codex_home, &destination, "auth.json", Some(&content))
        .map_err(|error| error.to_string())?;
    write_private_file(&destination, content).map_err(|error| error.to_string())?;
    set_active_account_key(registry, account_key, false);
    sync_config_for_provider(codex_home, registry.accounts[index].provider.as_ref())
}

pub fn switch_account(codex_home: &Path, account_key: &str) -> Result<Registry, String> {
    let mut registry = load_registry_for_update(codex_home)?;
    activate_account(codex_home, &mut registry, account_key)?;
    save_registry(codex_home, &mut registry)?;
    Ok(registry)
}

fn remaining_percent(window: Option<&Value>, now: i64) -> Option<i64> {
    let window = window?;
    let used = window.get("used_percent")?.as_f64()?;
    if window
        .get("resets_at")
        .and_then(Value::as_i64)
        .is_some_and(|reset| reset <= now)
    {
        return Some(100);
    }
    Some((100.0 - used).floor().clamp(0.0, 100.0) as i64)
}

fn usage_score(usage: Option<&Value>, now: i64) -> Option<i64> {
    let usage = usage?;
    let primary = usage.get("primary");
    let secondary = usage.get("secondary");
    match (
        remaining_percent(primary, now),
        remaining_percent(secondary, now),
    ) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn best_remaining_key(registry: &Registry, removed_key: &str) -> Option<String> {
    let now = now_seconds();
    registry
        .accounts
        .iter()
        .filter(|account| account.account_key != removed_key)
        .max_by_key(|account| {
            (
                usage_score(account.last_usage.as_ref(), now).unwrap_or(-1),
                account.last_usage_at.unwrap_or(-1),
            )
        })
        .map(|account| account.account_key.clone())
}

pub fn remove_account(codex_home: &Path, account_key: &str) -> Result<Registry, String> {
    let mut registry = load_registry_for_update(codex_home)?;
    let index = find_account_index(&registry, account_key)
        .ok_or_else(|| "Account not found in registry.".to_string())?;
    let active_removed = registry.active_account_key.as_deref() == Some(account_key);
    let removed_had_provider = registry.accounts[index].provider.is_some();

    if active_removed {
        if let Some(replacement_key) = best_remaining_key(&registry, account_key) {
            let replacement_index = find_account_index(&registry, &replacement_key).unwrap();
            let replacement_auth = account_auth_path(codex_home, &replacement_key);
            if replacement_auth.exists() {
                let content = fs::read(&replacement_auth).map_err(|error| error.to_string())?;
                write_private_file(&active_auth_path(codex_home), content)
                    .map_err(|error| error.to_string())?;
            }
            set_active_account_key(&mut registry, &replacement_key, true);
            sync_config_for_provider(
                codex_home,
                registry.accounts[replacement_index].provider.as_ref(),
            )?;
        } else {
            registry.active_account_key = None;
            registry.active_account_activated_at_ms = None;
            if removed_had_provider {
                sync_config_for_provider(codex_home, None)?;
            }
        }
    }
    if registry.previous_active_account_key.as_deref() == Some(account_key) {
        registry.previous_active_account_key = None;
    }
    remove_file_if_exists(&account_auth_path(codex_home, account_key))
        .map_err(|error| format!("Failed to remove account credentials: {error}"))?;
    registry.accounts.remove(index);
    if registry.accounts.is_empty() {
        remove_file_if_exists(&active_auth_path(codex_home))
            .map_err(|error| format!("Failed to remove active credentials: {error}"))?;
    }
    save_registry(codex_home, &mut registry)?;
    Ok(registry)
}

fn record_freshness(account: &Account) -> i64 {
    [
        account.created_at,
        account.last_used_at,
        account.last_usage_at,
    ]
    .into_iter()
    .flatten()
    .max()
    .unwrap_or(0)
}

fn upsert_account(registry: &mut Registry, mut incoming: Account) {
    let Some(index) = find_account_index(registry, &incoming.account_key) else {
        registry.accounts.push(incoming);
        return;
    };
    let existing = &mut registry.accounts[index];
    if record_freshness(&incoming) >= record_freshness(existing) {
        if incoming.alias.is_empty() {
            incoming.alias = existing.alias.clone();
        }
        if incoming.account_name.is_none() {
            incoming.account_name = existing.account_name.clone();
        }
        if incoming.last_usage.is_none() {
            incoming.last_usage = existing.last_usage.clone();
            incoming.last_usage_at = existing.last_usage_at;
        }
        *existing = incoming;
    } else {
        if existing.alias.is_empty() && !incoming.alias.is_empty() {
            existing.alias = incoming.alias;
        }
        if existing.account_name.is_none() {
            existing.account_name = incoming.account_name;
        }
        if existing.plan.is_none() {
            existing.plan = incoming.plan;
        }
        if existing.auth_mode.is_none() {
            existing.auth_mode = incoming.auth_mode;
        }
        if incoming.provider.is_some() {
            existing.provider = incoming.provider;
        }
    }
}

fn base_account(account_key: String, auth_mode: &str, provider: Option<Provider>) -> Account {
    Account {
        account_key,
        chatgpt_account_id: String::new(),
        chatgpt_user_id: String::new(),
        email: String::new(),
        alias: String::new(),
        account_name: None,
        plan: None,
        auth_mode: Some(auth_mode.to_string()),
        created_at: Some(now_seconds()),
        last_used_at: None,
        last_usage: None,
        last_usage_at: None,
        last_local_rollout: None,
        provider,
        extra: Map::new(),
    }
}

pub fn persist_chatgpt_login(
    codex_home: &Path,
    id_token: String,
    access_token: String,
    refresh_token: String,
) -> Result<(Registry, Option<String>), String> {
    let mut auth = json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": id_token,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "account_id": null
        },
        "last_refresh": Utc::now().to_rfc3339()
    });
    let identity = parse_chatgpt_identity(&auth).ok_or_else(|| {
        "Sign-in completed but the returned identity token was missing account details.".to_string()
    })?;
    auth["tokens"]["account_id"] = Value::String(identity.account_id.clone());
    let mut serialized = serde_json::to_string_pretty(&auth).map_err(|error| error.to_string())?;
    serialized.push('\n');

    let mut registry = load_registry_for_update(codex_home)?;
    ensure_accounts_dir(codex_home).map_err(|error| error.to_string())?;
    let active_path = active_auth_path(codex_home);
    backup_file_if_changed(codex_home, &active_path, "auth.json", Some(&serialized))
        .map_err(|error| error.to_string())?;
    write_private_file(&active_path, &serialized).map_err(|error| error.to_string())?;
    write_private_file(
        &account_auth_path(codex_home, &identity.record_key),
        &serialized,
    )
    .map_err(|error| error.to_string())?;

    upsert_account(
        &mut registry,
        Account {
            chatgpt_account_id: identity.account_id,
            chatgpt_user_id: identity.user_id,
            email: identity.email.clone().unwrap_or_default(),
            plan: identity.plan,
            ..base_account(identity.record_key.clone(), "chatgpt", None)
        },
    );
    set_active_account_key(&mut registry, &identity.record_key, false);
    sync_config_for_provider(codex_home, None)?;
    save_registry(codex_home, &mut registry)?;
    Ok((registry, identity.email))
}

pub fn add_provider_account(
    codex_home: &Path,
    options: AddProviderOptions,
) -> Result<Registry, String> {
    let base_url = normalize_provider_base_url(&options.base_url)
        .ok_or_else(|| "Enter a full endpoint URL such as https://codex.example.com".to_string())?;
    if is_native_anthropic_base_url(&base_url) {
        return Err("Native Anthropic Messages endpoints are not supported by Codex. Use a Responses-compatible Claude gateway endpoint.".into());
    }
    let api_key = options.api_key.trim();
    if api_key.is_empty() {
        return Err("API key is required.".into());
    }
    let host =
        provider_host(&base_url).ok_or_else(|| "The endpoint URL has no host.".to_string())?;
    let provider_id = sanitize_provider_id(if options.name.trim().is_empty() {
        &host
    } else {
        options.name.trim()
    })
    .ok_or_else(|| "The provider name contains no usable characters.".to_string())?;
    let (reasoning_effort_was_provided, explicit_reasoning_effort) = match options.reasoning_effort
    {
        ReasoningEffort::Missing => (false, None),
        ReasoningEffort::Null => (true, None),
        ReasoningEffort::Value(value) => (
            true,
            Some(value.trim().to_string()).filter(|value| !value.is_empty()),
        ),
    };
    let provider_model = options.model.trim();
    if matches!(
        options.provider_kind.as_str(),
        "claude-responses" | "custom-responses"
    ) && provider_model.is_empty()
    {
        return Err("Model is required for Claude and custom Responses providers.".into());
    }
    let mut provider = Provider {
        id: provider_id,
        base_url,
        model: if provider_model.is_empty() {
            DEFAULT_PROVIDER_MODEL.to_string()
        } else {
            provider_model.to_string()
        },
        model_reasoning_effort: explicit_reasoning_effort,
        extra: Map::new(),
    };
    if !reasoning_effort_was_provided
        && provider.model_reasoning_effort.is_none()
        && !provider_needs_model_catalog(&provider)
    {
        provider.model_reasoning_effort = Some(DEFAULT_PROVIDER_REASONING_EFFORT.into());
    }
    if provider_needs_model_catalog(&provider) {
        provider.model_reasoning_effort = None;
    }
    let record_key = provider_account_key(&host, api_key);
    ensure_accounts_dir(codex_home).map_err(|error| error.to_string())?;
    let mut auth = serde_json::to_string_pretty(&json!({ "OPENAI_API_KEY": api_key }))
        .map_err(|error| error.to_string())?;
    auth.push('\n');
    write_private_file(&account_auth_path(codex_home, &record_key), auth)
        .map_err(|error| error.to_string())?;

    let mut registry = load_registry_for_update(codex_home)?;
    upsert_account(
        &mut registry,
        Account {
            email: host,
            alias: options.name.trim().to_string(),
            account_name: Some(api_key_account_name(api_key)),
            ..base_account(record_key.clone(), "provider", Some(provider))
        },
    );
    activate_account(codex_home, &mut registry, &record_key)?;
    save_registry(codex_home, &mut registry)?;
    Ok(registry)
}

pub fn read_auth_value(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

pub fn read_account_auth(
    codex_home: &Path,
    account_key: &str,
    active_key: Option<&str>,
) -> Option<Value> {
    let mut paths = Vec::new();
    if active_key == Some(account_key) {
        paths.push(active_auth_path(codex_home));
    }
    paths.push(account_auth_path(codex_home, account_key));
    paths.into_iter().find_map(|path| read_auth_value(&path))
}

fn api_key_from_auth(auth: &Value) -> Option<&str> {
    auth.get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub fn update_provider_account(
    codex_home: &Path,
    account_key: &str,
    options: UpdateProviderOptions,
) -> Result<Registry, String> {
    let mut registry = load_registry_for_update(codex_home)?;
    let index = find_account_index(&registry, account_key)
        .ok_or_else(|| "API provider account not found.".to_string())?;
    if registry.accounts[index].auth_mode.as_deref() != Some("provider")
        || registry.accounts[index].provider.is_none()
    {
        return Err("API provider account not found.".into());
    }

    let stored_auth = read_account_auth(
        codex_home,
        account_key,
        registry.active_account_key.as_deref(),
    );
    let replacement_api_key = options
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let effective_api_key = replacement_api_key
        .or_else(|| stored_auth.as_ref().and_then(api_key_from_auth))
        .ok_or_else(|| "The stored API key is missing. Enter a replacement API key.".to_string())?
        .to_string();

    let old_account_key = registry.accounts[index].account_key.clone();
    let new_account_key = if replacement_api_key.is_some() {
        let provider = registry.accounts[index].provider.as_ref().unwrap();
        let host = provider_host(&provider.base_url)
            .ok_or_else(|| "The stored endpoint URL has no host.".to_string())?;
        provider_account_key(&host, &effective_api_key)
    } else {
        old_account_key.clone()
    };
    if find_account_index(&registry, &new_account_key).is_some_and(|found| found != index) {
        return Err("Another API provider account already uses this endpoint and API key.".into());
    }

    let replacement_model = options.model.as_deref().map(str::trim);
    let was_active = registry.active_account_key.as_deref() == Some(account_key);
    let was_previous = registry.previous_active_account_key.as_deref() == Some(account_key);
    {
        let account = &mut registry.accounts[index];
        account.account_key = new_account_key.clone();
        if replacement_api_key.is_some() {
            account.account_name = Some(api_key_account_name(&effective_api_key));
        }
        if let Some(model) = replacement_model {
            let provider = account.provider.as_mut().unwrap();
            provider.model = if model.is_empty() {
                DEFAULT_PROVIDER_MODEL.to_string()
            } else {
                model.to_string()
            };
            if provider_needs_model_catalog(provider) {
                provider.model_reasoning_effort = None;
            }
        }
    }
    if was_active {
        registry.active_account_key = Some(new_account_key.clone());
    }
    if was_previous {
        registry.previous_active_account_key = Some(new_account_key.clone());
    }

    let mut auth = stored_auth.unwrap_or_else(|| json!({}));
    if !auth.is_object() {
        auth = json!({});
    }
    auth["OPENAI_API_KEY"] = Value::String(effective_api_key);
    let mut serialized_auth =
        serde_json::to_string_pretty(&auth).map_err(|error| error.to_string())?;
    serialized_auth.push('\n');

    ensure_accounts_dir(codex_home).map_err(|error| error.to_string())?;
    write_private_file(
        &account_auth_path(codex_home, &new_account_key),
        &serialized_auth,
    )
    .map_err(|error| error.to_string())?;
    if was_active {
        let active_path = active_auth_path(codex_home);
        backup_file_if_changed(
            codex_home,
            &active_path,
            "auth.json",
            Some(&serialized_auth),
        )
        .map_err(|error| error.to_string())?;
        write_private_file(&active_path, &serialized_auth).map_err(|error| error.to_string())?;
        sync_config_for_provider(codex_home, registry.accounts[index].provider.as_ref())?;
    }
    save_registry(codex_home, &mut registry)?;
    if old_account_key != new_account_key {
        let _ = remove_file_if_exists(&account_auth_path(codex_home, &old_account_key));
    }
    Ok(registry)
}

pub fn provider_test_options(
    codex_home: &Path,
    account_key: &str,
    draft: Option<&UpdateProviderOptions>,
) -> Result<ProviderTestOptions, String> {
    let registry = load_registry(codex_home)?;
    let account = registry
        .accounts
        .iter()
        .find(|account| account.account_key == account_key)
        .filter(|account| account.auth_mode.as_deref() == Some("provider"))
        .ok_or_else(|| "API provider account not found.".to_string())?;
    let provider = account
        .provider
        .as_ref()
        .ok_or_else(|| "API provider account not found.".to_string())?;
    let draft_api_key = draft
        .and_then(|options| options.api_key.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let stored_auth = if draft_api_key.is_none() {
        read_account_auth(
            codex_home,
            account_key,
            registry.active_account_key.as_deref(),
        )
    } else {
        None
    };
    let api_key = draft_api_key
        .or_else(|| stored_auth.as_ref().and_then(api_key_from_auth))
        .ok_or_else(|| "The stored API key is missing. Enter a replacement API key.".to_string())?;
    let model = match draft.and_then(|options| options.model.as_deref()) {
        Some(value) if value.trim().is_empty() => DEFAULT_PROVIDER_MODEL,
        Some(value) => value.trim(),
        None => &provider.model,
    };
    Ok(ProviderTestOptions {
        base_url: provider.base_url.clone(),
        api_key: api_key.to_string(),
        model: model.to_string(),
    })
}

pub fn persist_usages(
    codex_home: &Path,
    usages: HashMap<String, Value>,
) -> Result<Registry, String> {
    let mut registry = load_registry(codex_home)?;
    let now = now_seconds();
    let mut changed = false;
    for account in &mut registry.accounts {
        if let Some(usage) = usages.get(&account.account_key) {
            account.last_usage = Some(usage.clone());
            account.last_usage_at = Some(now);
            changed = true;
        }
    }
    if changed {
        save_registry(codex_home, &mut registry)?;
    }
    Ok(registry)
}

fn non_empty_string_field<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn convert_sub2api_payload(payload: &Value) -> Result<Value, String> {
    if payload
        .get("version")
        .and_then(Value::as_u64)
        .is_some_and(|version| version > 1)
    {
        return Err("This sub2api export was created by a newer app version.".into());
    }
    let source_accounts = payload
        .get("accounts")
        .and_then(Value::as_array)
        .ok_or_else(|| "This file is not a valid sub2api account export.".to_string())?;
    let mut accounts = Vec::with_capacity(source_accounts.len());
    let mut auths = Map::new();
    for source_account in source_accounts {
        let Some(source_account) = source_account.as_object() else {
            accounts.push(Value::Null);
            continue;
        };
        let is_openai_oauth = non_empty_string_field(source_account, "platform")
            .is_some_and(|value| value.eq_ignore_ascii_case("openai"))
            && non_empty_string_field(source_account, "type")
                .is_some_and(|value| value.eq_ignore_ascii_case("oauth"));
        let Some(credentials) = source_account
            .get("credentials")
            .and_then(Value::as_object)
            .filter(|_| is_openai_oauth)
        else {
            accounts.push(Value::Null);
            continue;
        };
        let Some(id_token) = non_empty_string_field(credentials, "id_token") else {
            accounts.push(Value::Null);
            continue;
        };
        let Some(access_token) = non_empty_string_field(credentials, "access_token") else {
            accounts.push(Value::Null);
            continue;
        };
        let refresh_token = non_empty_string_field(credentials, "refresh_token");
        let mut auth = json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": id_token,
                "access_token": access_token,
                "account_id": null
            }
        });
        if let Some(refresh_token) = refresh_token {
            auth["tokens"]["refresh_token"] = Value::String(refresh_token.to_string());
        }
        let Some(identity) = parse_chatgpt_identity(&auth) else {
            accounts.push(Value::Null);
            continue;
        };
        auth["tokens"]["account_id"] = Value::String(identity.account_id.clone());

        let email = identity
            .email
            .clone()
            .or_else(|| {
                non_empty_string_field(credentials, "email").map(|value| value.to_lowercase())
            })
            .unwrap_or_default();
        let alias = non_empty_string_field(source_account, "name")
            .filter(|name| !name.eq_ignore_ascii_case(&email))
            .unwrap_or_default()
            .to_string();
        let account = Account {
            chatgpt_account_id: identity.account_id,
            chatgpt_user_id: identity.user_id,
            email,
            alias,
            plan: identity.plan,
            ..base_account(identity.record_key.clone(), "chatgpt", None)
        };
        let account_value = serde_json::to_value(account)
            .map_err(|error| format!("Failed to convert sub2api account data: {error}"))?;
        accounts.push(account_value);
        auths.insert(identity.record_key, auth);
    }
    Ok(json!({
        "type": "codex-auth-accounts",
        "version": 1,
        "registry": { "accounts": accounts },
        "auths": auths
    }))
}

fn merge_sub2api_account(existing: &mut Account, incoming: Account) {
    existing.chatgpt_account_id = incoming.chatgpt_account_id;
    existing.chatgpt_user_id = incoming.chatgpt_user_id;
    existing.email = incoming.email;
    if !incoming.alias.is_empty() {
        existing.alias = incoming.alias;
    }
    if incoming.plan.is_some() {
        existing.plan = incoming.plan;
    }
    existing.auth_mode = incoming.auth_mode;
    existing.provider = None;
}

pub fn import_payload(codex_home: &Path, mut payload: Value) -> Value {
    let is_sub2api = payload.get("type").and_then(Value::as_str) == Some("sub2api-data");
    if is_sub2api {
        payload = match convert_sub2api_payload(&payload) {
            Ok(payload) => payload,
            Err(error) => return json!({ "ok": false, "error": error }),
        };
    }
    if payload.get("type").and_then(Value::as_str) != Some("codex-auth-accounts")
        || !payload
            .pointer("/registry/accounts")
            .is_some_and(Value::is_array)
    {
        return json!({ "ok": false, "error": "This file is not a codex-auth account export." });
    }
    if payload
        .get("version")
        .and_then(Value::as_u64)
        .is_some_and(|version| version > 1)
    {
        return json!({ "ok": false, "error": "This export was created by a newer app version." });
    }
    let incoming = payload
        .pointer("/registry/accounts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if incoming.is_empty() {
        return json!({ "ok": false, "error": "The export file contains no accounts." });
    }
    let mut registry = match load_registry_for_update(codex_home) {
        Ok(registry) => registry,
        Err(error) => {
            return json!({ "ok": false, "error": format!("Failed to load registry: {error}") })
        }
    };
    let auths = payload
        .get("auths")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut added = 0_u64;
    let mut updated = 0_u64;
    let mut skipped = 0_u64;
    for account_value in incoming {
        let Some(account_key) = account_value
            .get("account_key")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            skipped += 1;
            continue;
        };
        let Some(mut auth) = auths
            .get(&account_key)
            .filter(|value| value.is_object())
            .cloned()
        else {
            skipped += 1;
            continue;
        };
        ensure_chatgpt_refresh_metadata(&mut auth);
        let account: Account = match serde_json::from_value(account_value) {
            Ok(account) => account,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let mut serialized = match serde_json::to_string_pretty(&auth) {
            Ok(value) => value,
            Err(error) => {
                return json!({ "ok": false, "error": format!("Failed to serialize auth: {error}") })
            }
        };
        serialized.push('\n');
        if let Err(error) =
            write_private_file(&account_auth_path(codex_home, &account_key), &serialized)
        {
            return json!({ "ok": false, "error": format!("Failed to write auth for {account_key}: {error}") });
        }
        if registry.active_account_key.as_deref() == Some(account_key.as_str()) {
            let _ = write_private_file(&active_auth_path(codex_home), &serialized);
        }
        if let Some(index) = find_account_index(&registry, &account_key) {
            if is_sub2api {
                merge_sub2api_account(&mut registry.accounts[index], account);
            } else {
                registry.accounts[index] = account;
            }
            updated += 1;
        } else {
            registry.accounts.push(account);
            added += 1;
        }
    }
    if added == 0 && updated == 0 {
        return json!({ "ok": false, "error": "No account in the file had usable auth data." });
    }
    if let Err(error) = save_registry(codex_home, &mut registry) {
        return json!({ "ok": false, "error": format!("Failed to save registry: {error}") });
    }
    json!({ "ok": true, "added": added, "updated": updated, "skipped": skipped, "registryData": registry })
}

pub fn build_export_payload(
    codex_home: &Path,
    account_key: Option<&str>,
) -> Result<(Value, usize, Vec<String>, String), String> {
    let registry = load_registry(codex_home)?;
    let selected = match account_key.filter(|value| !value.is_empty()) {
        Some(key) => {
            let account = registry
                .accounts
                .iter()
                .find(|account| account.account_key == key)
                .cloned()
                .ok_or_else(|| "Account not found.".to_string())?;
            vec![account]
        }
        None => registry.accounts.clone(),
    };
    if selected.is_empty() {
        return Err("No accounts to export.".into());
    }
    let mut export_registry = registry.clone();
    export_registry.accounts = selected.clone();
    if let Some(key) = account_key {
        export_registry.active_account_key =
            (registry.active_account_key.as_deref() == Some(key)).then(|| key.to_string());
        export_registry.previous_active_account_key = None;
    }
    let mut auths = Map::new();
    let mut missing = Vec::new();
    for account in &selected {
        if let Some(auth) = read_account_auth(
            codex_home,
            &account.account_key,
            registry.active_account_key.as_deref(),
        ) {
            auths.insert(account.account_key.clone(), auth);
        } else {
            missing.push(if account.email.is_empty() {
                account.account_key.clone()
            } else {
                account.email.clone()
            });
        }
    }
    let exported = auths.len();
    let scope = if account_key.is_some() {
        "single"
    } else {
        "all"
    }
    .to_string();
    Ok((
        json!({
            "type": "codex-auth-accounts",
            "version": 1,
            "exported_at": Utc::now().to_rfc3339(),
            "registry": export_registry,
            "auths": auths
        }),
        exported,
        missing,
        scope,
    ))
}

pub fn account_label(codex_home: &Path, account_key: &str) -> Option<String> {
    let registry = load_registry(codex_home).ok()?;
    let account = registry
        .accounts
        .iter()
        .find(|account| account.account_key == account_key)?;
    Some(if !account.email.is_empty() {
        account.email.clone()
    } else if !account.alias.is_empty() {
        account.alias.clone()
    } else {
        account_key.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_home(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("codex-auth-tauri-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn fake_id_token(email: &str, user_id: &str, account_id: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
        let claims = json!({
            "email": email,
            "https://api.openai.com/auth": {
                "chatgpt_user_id": user_id,
                "chatgpt_account_id": account_id,
                "chatgpt_plan_type": "plus"
            }
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        format!("{header}.{payload}.")
    }

    fn chatgpt_auth(email: &str, user_id: &str, account_id: &str) -> Value {
        json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": fake_id_token(email, user_id, account_id),
                "access_token": "access-token",
                "refresh_token": "refresh-token",
                "account_id": account_id
            }
        })
    }

    fn provider_options(name: &str, key: &str) -> AddProviderOptions {
        AddProviderOptions {
            base_url: format!("https://{name}.example.com/v1/responses"),
            api_key: key.into(),
            name: name.into(),
            model: String::new(),
            provider_kind: String::new(),
            reasoning_effort: ReasoningEffort::Missing,
        }
    }

    #[test]
    fn snapshot_paths_match_the_zig_filename_contract() {
        let home = Path::new("codex-home");
        assert_eq!(
            account_auth_path(home, "safe-key_1.2"),
            home.join("accounts/safe-key_1.2.auth.json")
        );
        assert_eq!(
            account_auth_path(home, "user::account"),
            home.join("accounts/dXNlcjo6YWNjb3VudA.auth.json")
        );
        assert_eq!(
            account_auth_path(home, "."),
            home.join("accounts/Lg.auth.json")
        );
    }

    #[test]
    fn future_registry_schema_is_rejected_without_writes() {
        let home = temporary_home("future-schema");
        ensure_accounts_dir(&home).unwrap();
        let original = "{\n  \"schema_version\": 999,\n  \"accounts\": []\n}\n";
        fs::write(registry_path(&home), original).unwrap();

        let error = load_registry(&home).unwrap_err();
        assert!(error.contains("schema version 999"));

        let payload = json!({
            "type": "codex-auth-accounts",
            "version": 1,
            "registry": {
                "accounts": [{ "account_key": "safe-key" }]
            },
            "auths": {
                "safe-key": { "OPENAI_API_KEY": "sk-test" }
            }
        });
        let result = import_payload(&home, payload);
        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(false));
        assert!(result
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("schema version 999")));
        assert_eq!(fs::read_to_string(registry_path(&home)).unwrap(), original);
        assert!(!account_auth_path(&home, "safe-key").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn malformed_registry_without_a_valid_backup_is_preserved() {
        let home = temporary_home("malformed-no-backup");
        ensure_accounts_dir(&home).unwrap();
        let malformed = "{ invalid registry";
        fs::write(registry_path(&home), malformed).unwrap();

        let token = fake_id_token("repair@example.com", "repair-user", "repair-account");
        let error =
            persist_chatgpt_login(&home, token, "access-token".into(), "refresh-token".into())
                .unwrap_err();

        assert!(error.contains("no valid registry backup"));
        assert_eq!(fs::read_to_string(registry_path(&home)).unwrap(), malformed);
        assert!(!account_auth_path(&home, "repair-user::repair-account").exists());
        assert!(fs::read_dir(accounts_dir(&home))
            .unwrap()
            .flatten()
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("registry.json.bak.")
                    && fs::read_to_string(entry.path()).ok().as_deref() == Some(malformed)
            }));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn valid_backup_repairs_malformed_registry_without_losing_provider_accounts() {
        let home = temporary_home("malformed-valid-backup");
        let mut original =
            add_provider_account(&home, provider_options("preserved", "sk-preserved")).unwrap();
        original.accounts[0].alias = "Preserved".into();
        save_registry(&home, &mut original).unwrap();
        let malformed = "{ invalid registry";
        fs::write(registry_path(&home), malformed).unwrap();

        let token = fake_id_token("repair@example.com", "repair-user", "repair-account");
        let (registry, _) =
            persist_chatgpt_login(&home, token, "access-token".into(), "refresh-token".into())
                .unwrap();

        assert_eq!(registry.accounts.len(), 2);
        assert_eq!(
            registry.active_account_key.as_deref(),
            Some("repair-user::repair-account")
        );
        assert_eq!(
            registry
                .accounts
                .iter()
                .filter(|account| account.provider.is_some())
                .count(),
            1
        );
        assert!(fs::read_dir(accounts_dir(&home))
            .unwrap()
            .flatten()
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("registry.json.bak.")
                    && fs::read_to_string(entry.path()).ok().as_deref() == Some(malformed)
            }));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn startup_repair_recovers_an_authorized_account_from_auth_json() {
        let home = temporary_home("startup-repair");
        let auth = chatgpt_auth("existing@example.com", "existing-user", "existing-account");
        write_private_file(
            &active_auth_path(&home),
            serde_json::to_vec_pretty(&auth).unwrap(),
        )
        .unwrap();

        let repaired = repair_registry_from_auth_files(&home).unwrap();

        assert_eq!(repaired.accounts.len(), 1);
        assert_eq!(
            repaired.active_account_key.as_deref(),
            Some("existing-user::existing-account")
        );
        assert_eq!(repaired.accounts[0].email, "existing@example.com");
        assert_eq!(load_registry(&home).unwrap().accounts.len(), 1);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn startup_repair_merges_active_auth_into_nonempty_registry() {
        let home = temporary_home("startup-merge");
        let existing =
            add_provider_account(&home, provider_options("existing", "sk-existing")).unwrap();
        let auth = chatgpt_auth("orphan@example.com", "orphan-user", "orphan-account");
        write_private_file(
            &active_auth_path(&home),
            serde_json::to_vec_pretty(&auth).unwrap(),
        )
        .unwrap();

        let repaired = repair_registry_from_auth_files(&home).unwrap();

        assert_eq!(existing.accounts.len(), 1);
        assert_eq!(repaired.accounts.len(), 2);
        assert!(repaired
            .accounts
            .iter()
            .any(|account| account.account_key == "orphan-user::orphan-account"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn import_accepts_null_account_and_provider_string_metadata() {
        let home = temporary_home("null-import");
        let payload = json!({
            "type": "codex-auth-accounts",
            "version": 1,
            "registry": {
                "accounts": [{
                    "account_key": "imported-account",
                    "chatgpt_account_id": null,
                    "chatgpt_user_id": null,
                    "email": null,
                    "alias": null,
                    "auth_mode": "provider",
                    "provider": {
                        "id": "imported-provider",
                        "base_url": "https://provider.example.com/v1",
                        "model": null
                    }
                }]
            },
            "auths": {
                "imported-account": { "OPENAI_API_KEY": "sk-test" }
            }
        });

        let result = import_payload(&home, payload);

        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(true));
        let imported = load_registry(&home).unwrap();
        assert_eq!(imported.accounts.len(), 1);
        assert_eq!(imported.accounts[0].account_key, "imported-account");
        assert!(imported.accounts[0].email.is_empty());
        assert!(imported.accounts[0]
            .provider
            .as_ref()
            .unwrap()
            .model
            .is_empty());
        assert!(account_auth_path(&home, "imported-account").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn import_accepts_sub2api_openai_oauth_accounts() {
        let home = temporary_home("sub2api-import");
        let id_token = fake_id_token("person@example.com", "person-user", "person-account");
        let payload = json!({
            "type": "sub2api-data",
            "version": 1,
            "exported_at": "2026-07-23T13:28:03Z",
            "proxies": [],
            "accounts": [
                {
                    "name": "Primary",
                    "platform": "openai",
                    "type": "oauth",
                    "credentials": {
                        "access_token": "sub2-access-token",
                        "expires_at": "2026-08-01T00:00:00Z",
                        "refresh_token": "sub2-refresh-token",
                        "id_token": id_token,
                        "email": "person@example.com",
                        "account_id": "person-account",
                        "chatgpt_account_id": "person-account"
                    },
                    "concurrency": 10,
                    "priority": 1,
                    "rate_multiplier": 1,
                    "auto_pause_on_expired": true
                },
                {
                    "name": "Unsupported",
                    "platform": "other",
                    "type": "oauth",
                    "credentials": {}
                }
            ]
        });

        let result = import_payload(&home, payload);

        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(result.get("added").and_then(Value::as_u64), Some(1));
        assert_eq!(result.get("updated").and_then(Value::as_u64), Some(0));
        assert_eq!(result.get("skipped").and_then(Value::as_u64), Some(1));
        let imported = load_registry(&home).unwrap();
        assert_eq!(imported.accounts.len(), 1);
        assert_eq!(
            imported.accounts[0].account_key,
            "person-user::person-account"
        );
        assert_eq!(imported.accounts[0].email, "person@example.com");
        assert_eq!(imported.accounts[0].alias, "Primary");
        assert_eq!(imported.accounts[0].auth_mode.as_deref(), Some("chatgpt"));
        assert_eq!(imported.accounts[0].plan.as_deref(), Some("plus"));
        let auth =
            read_auth_value(&account_auth_path(&home, "person-user::person-account")).unwrap();
        assert_eq!(
            auth.pointer("/tokens/access_token").and_then(Value::as_str),
            Some("sub2-access-token")
        );
        assert_eq!(
            auth.pointer("/tokens/refresh_token")
                .and_then(Value::as_str),
            Some("sub2-refresh-token")
        );
        assert_eq!(
            auth.pointer("/tokens/account_id").and_then(Value::as_str),
            Some("person-account")
        );
        assert!(auth
            .get("last_refresh")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()));

        let snapshot_path = account_auth_path(&home, "person-user::person-account");
        let mut snapshot_without_refresh = auth;
        snapshot_without_refresh
            .as_object_mut()
            .unwrap()
            .remove("last_refresh");
        write_private_file(
            &snapshot_path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&snapshot_without_refresh).unwrap()
            ),
        )
        .unwrap();

        switch_account(&home, "person-user::person-account").unwrap();

        let active_path = active_auth_path(&home);
        for path in [&snapshot_path, &active_path] {
            let repaired = read_auth_value(path).unwrap();
            assert!(repaired
                .get("last_refresh")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty()));
        }

        let mut existing = load_registry(&home).unwrap();
        existing.accounts[0].alias = "Local alias".into();
        existing.accounts[0].last_usage = Some(json!({ "plan_type": "plus" }));
        existing.accounts[0].last_usage_at = Some(123);
        save_registry(&home, &mut existing).unwrap();
        let updated_payload = json!({
            "type": "sub2api-data",
            "version": 1,
            "accounts": [{
                "name": "person@example.com",
                "platform": "openai",
                "type": "oauth",
                "credentials": {
                    "access_token": "updated-access-token",
                    "refresh_token": "updated-refresh-token",
                    "id_token": fake_id_token(
                        "person@example.com",
                        "person-user",
                        "person-account"
                    ),
                    "email": "person@example.com",
                    "account_id": "person-account",
                    "chatgpt_account_id": "person-account"
                }
            }]
        });

        let updated_result = import_payload(&home, updated_payload);

        assert_eq!(
            updated_result.get("updated").and_then(Value::as_u64),
            Some(1)
        );
        let updated = load_registry(&home).unwrap();
        assert_eq!(updated.accounts[0].alias, "Local alias");
        assert_eq!(updated.accounts[0].last_usage_at, Some(123));
        let updated_auth =
            read_auth_value(&account_auth_path(&home, "person-user::person-account")).unwrap();
        assert_eq!(
            updated_auth
                .pointer("/tokens/access_token")
                .and_then(Value::as_str),
            Some("updated-access-token")
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn sub2api_import_rejects_newer_versions_without_writes() {
        let home = temporary_home("sub2api-future");
        let payload = json!({
            "type": "sub2api-data",
            "version": 2,
            "accounts": []
        });

        let result = import_payload(&home, payload);

        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(false));
        assert!(result
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("newer app version")));
        assert!(!registry_path(&home).exists());
        assert!(!accounts_dir(&home).exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn provider_login_writes_private_auth_and_managed_config() {
        let home = temporary_home("provider");
        let registry =
            add_provider_account(&home, provider_options("apiz", "sk-test-one")).unwrap();
        assert_eq!(registry.accounts.len(), 1);
        assert_eq!(
            registry.active_account_key,
            Some(registry.accounts[0].account_key.clone())
        );
        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(config.contains("model = \"gpt-5.6-sol\""));
        assert!(config.contains("model_reasoning_effort = \"medium\""));
        assert!(config.contains("[model_providers.apiz]"));
        let auth = read_auth_value(&active_auth_path(&home)).unwrap();
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(Value::as_str),
            Some("sk-test-one")
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn updating_active_provider_rotates_key_and_model_without_losing_metadata() {
        let home = temporary_home("provider-update-active");
        let added = add_provider_account(&home, provider_options("apiz", "sk-old")).unwrap();
        let old_key = added.active_account_key.unwrap();

        let mut seeded = load_registry(&home).unwrap();
        seeded.accounts[0]
            .extra
            .insert("future_account_field".into(), json!({ "kept": true }));
        seeded.accounts[0]
            .provider
            .as_mut()
            .unwrap()
            .extra
            .insert("future_provider_field".into(), json!(42));
        seeded.accounts[0].last_local_rollout = Some(json!({ "path": "rollout.jsonl" }));
        let original_created_at = seeded.accounts[0].created_at;
        let original_last_used_at = seeded.accounts[0].last_used_at;
        let original_activated_at = seeded.active_account_activated_at_ms;
        save_registry(&home, &mut seeded).unwrap();

        let updated = update_provider_account(
            &home,
            &old_key,
            UpdateProviderOptions {
                api_key: Some(" sk-new ".into()),
                model: Some(" gpt-5.7 ".into()),
            },
        )
        .unwrap();
        let new_key = provider_account_key("apiz.example.com", "sk-new");

        assert_eq!(updated.accounts.len(), 1);
        assert_eq!(
            updated.active_account_key.as_deref(),
            Some(new_key.as_str())
        );
        assert_eq!(updated.previous_active_account_key, None);
        assert_eq!(
            updated.active_account_activated_at_ms,
            original_activated_at
        );
        let account = &updated.accounts[0];
        assert_eq!(account.account_key, new_key);
        assert_eq!(account.created_at, original_created_at);
        assert_eq!(account.last_used_at, original_last_used_at);
        assert_eq!(
            account.extra.get("future_account_field"),
            Some(&json!({ "kept": true }))
        );
        assert_eq!(
            account
                .provider
                .as_ref()
                .unwrap()
                .extra
                .get("future_provider_field"),
            Some(&json!(42))
        );
        assert_eq!(
            account.last_local_rollout,
            Some(json!({ "path": "rollout.jsonl" }))
        );
        assert_eq!(account.provider.as_ref().unwrap().model, "gpt-5.7");

        assert!(!account_auth_path(&home, &old_key).exists());
        let snapshot = read_auth_value(&account_auth_path(&home, &new_key)).unwrap();
        assert_eq!(
            snapshot.get("OPENAI_API_KEY").and_then(Value::as_str),
            Some("sk-new")
        );
        let active_auth = read_auth_value(&active_auth_path(&home)).unwrap();
        assert_eq!(
            active_auth.get("OPENAI_API_KEY").and_then(Value::as_str),
            Some("sk-new")
        );
        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(config.contains("model = \"gpt-5.7\""));
        assert!(config.contains("review_model = \"gpt-5.7\""));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn updating_active_provider_model_with_blank_key_keeps_identity_and_normalizes_reasoning() {
        let home = temporary_home("provider-update-model");
        let added = add_provider_account(&home, provider_options("apiz", "sk-stored")).unwrap();
        let account_key = added.active_account_key.unwrap();

        let updated = update_provider_account(
            &home,
            &account_key,
            UpdateProviderOptions {
                api_key: Some("   ".into()),
                model: Some("deepseek-v4-pro".into()),
            },
        )
        .unwrap();

        assert_eq!(updated.accounts.len(), 1);
        assert_eq!(
            updated.active_account_key.as_deref(),
            Some(account_key.as_str())
        );
        let provider = updated.accounts[0].provider.as_ref().unwrap();
        assert_eq!(provider.model, "deepseek-v4-pro");
        assert_eq!(provider.model_reasoning_effort, None);
        let snapshot = read_auth_value(&account_auth_path(&home, &account_key)).unwrap();
        assert_eq!(
            snapshot.get("OPENAI_API_KEY").and_then(Value::as_str),
            Some("sk-stored")
        );
        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(config.contains("model = \"deepseek-v4-pro\""));
        assert!(config.contains("model_catalog_json"));
        assert!(!config.contains("model_reasoning_effort"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn updating_active_provider_blank_model_resets_to_default() {
        let home = temporary_home("provider-update-default-model");
        let mut add_options = provider_options("apiz", "sk-stored");
        add_options.model = "gpt-old".into();
        let added = add_provider_account(&home, add_options).unwrap();
        let account_key = added.active_account_key.unwrap();

        let updated = update_provider_account(
            &home,
            &account_key,
            UpdateProviderOptions {
                api_key: None,
                model: Some("   ".into()),
            },
        )
        .unwrap();

        assert_eq!(updated.accounts.len(), 1);
        assert_eq!(
            updated.active_account_key.as_deref(),
            Some(account_key.as_str())
        );
        assert_eq!(
            updated.accounts[0].provider.as_ref().unwrap().model,
            DEFAULT_PROVIDER_MODEL
        );
        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(config.contains("model = \"gpt-5.6-sol\""));
        assert!(!config.contains("model = \"gpt-old\""));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn updating_inactive_provider_rekeys_previous_without_switching_active_account() {
        let home = temporary_home("provider-update-inactive");
        let first = add_provider_account(&home, provider_options("one", "sk-one")).unwrap();
        let first_key = first.active_account_key.unwrap();
        let second = add_provider_account(&home, provider_options("two", "sk-two")).unwrap();
        let second_key = second.active_account_key.unwrap();
        assert_eq!(
            second.previous_active_account_key.as_deref(),
            Some(first_key.as_str())
        );
        let active_auth_before = fs::read(active_auth_path(&home)).unwrap();
        let config_before = fs::read(home.join("config.toml")).unwrap();
        let activated_at_before = second.active_account_activated_at_ms;

        let updated = update_provider_account(
            &home,
            &first_key,
            UpdateProviderOptions {
                api_key: Some("sk-one-new".into()),
                model: Some("gpt-5.7".into()),
            },
        )
        .unwrap();
        let new_first_key = provider_account_key("one.example.com", "sk-one-new");

        assert_eq!(updated.accounts.len(), 2);
        assert_eq!(
            updated.active_account_key.as_deref(),
            Some(second_key.as_str())
        );
        assert_eq!(
            updated.previous_active_account_key.as_deref(),
            Some(new_first_key.as_str())
        );
        assert_eq!(updated.active_account_activated_at_ms, activated_at_before);
        assert_eq!(
            fs::read(active_auth_path(&home)).unwrap(),
            active_auth_before
        );
        assert_eq!(fs::read(home.join("config.toml")).unwrap(), config_before);
        assert!(!account_auth_path(&home, &first_key).exists());
        assert!(account_auth_path(&home, &new_first_key).exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn updating_provider_rejects_account_key_collisions_without_mutating_storage() {
        let home = temporary_home("provider-update-collision");
        let first = add_provider_account(&home, provider_options("same", "sk-one")).unwrap();
        let first_key = first.active_account_key.unwrap();
        let second = add_provider_account(&home, provider_options("same", "sk-two")).unwrap();
        let second_key = second.active_account_key.unwrap();
        let registry_before = fs::read(registry_path(&home)).unwrap();
        let first_auth_before = fs::read(account_auth_path(&home, &first_key)).unwrap();
        let second_auth_before = fs::read(account_auth_path(&home, &second_key)).unwrap();

        let error = update_provider_account(
            &home,
            &first_key,
            UpdateProviderOptions {
                api_key: Some("sk-two".into()),
                model: Some("gpt-5.7".into()),
            },
        )
        .unwrap_err();

        assert!(error.contains("already uses this endpoint and API key"));
        assert_eq!(fs::read(registry_path(&home)).unwrap(), registry_before);
        assert_eq!(
            fs::read(account_auth_path(&home, &first_key)).unwrap(),
            first_auth_before
        );
        assert_eq!(
            fs::read(account_auth_path(&home, &second_key)).unwrap(),
            second_auth_before
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn updating_provider_rejects_missing_and_non_provider_accounts() {
        let home = temporary_home("provider-update-invalid-target");
        let mut registry = Registry::default();
        registry
            .accounts
            .push(base_account("chatgpt-account".into(), "chatgpt", None));
        save_registry(&home, &mut registry).unwrap();

        let missing =
            update_provider_account(&home, "missing-account", UpdateProviderOptions::default())
                .unwrap_err();
        assert_eq!(missing, "API provider account not found.");
        let non_provider =
            update_provider_account(&home, "chatgpt-account", UpdateProviderOptions::default())
                .unwrap_err();
        assert_eq!(non_provider, "API provider account not found.");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn provider_update_and_draft_test_can_repair_missing_credentials() {
        let home = temporary_home("provider-update-repair");
        let added = add_provider_account(&home, provider_options("repair", "sk-old")).unwrap();
        let account_key = added.active_account_key.unwrap();
        fs::remove_file(account_auth_path(&home, &account_key)).unwrap();
        fs::remove_file(active_auth_path(&home)).unwrap();

        let missing_error =
            update_provider_account(&home, &account_key, UpdateProviderOptions::default())
                .unwrap_err();
        assert!(missing_error.contains("Enter a replacement API key"));

        let draft = UpdateProviderOptions {
            api_key: Some("sk-draft".into()),
            model: Some("gpt-draft".into()),
        };
        let test_options = provider_test_options(&home, &account_key, Some(&draft)).unwrap();
        assert_eq!(test_options.api_key, "sk-draft");
        assert_eq!(test_options.model, "gpt-draft");

        let updated = update_provider_account(&home, &account_key, draft).unwrap();
        let new_key = provider_account_key("repair.example.com", "sk-draft");
        assert_eq!(
            updated.active_account_key.as_deref(),
            Some(new_key.as_str())
        );
        assert!(account_auth_path(&home, &new_key).exists());
        assert_eq!(
            read_auth_value(&active_auth_path(&home))
                .unwrap()
                .get("OPENAI_API_KEY")
                .and_then(Value::as_str),
            Some("sk-draft")
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn provider_test_draft_blank_key_uses_stored_key_and_blank_model_uses_default() {
        let home = temporary_home("provider-test-draft");
        let mut add_options = provider_options("draft", "sk-stored");
        add_options.model = "gpt-old".into();
        let added = add_provider_account(&home, add_options).unwrap();
        let account_key = added.active_account_key.unwrap();
        let draft = UpdateProviderOptions {
            api_key: Some("  ".into()),
            model: Some("  ".into()),
        };

        let options = provider_test_options(&home, &account_key, Some(&draft)).unwrap();
        assert_eq!(options.api_key, "sk-stored");
        assert_eq!(options.model, DEFAULT_PROVIDER_MODEL);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn explicit_null_reasoning_is_preserved_for_custom_provider() {
        let home = temporary_home("no-reasoning");
        let mut options = provider_options("custom", "sk-test-two");
        options.reasoning_effort = ReasoningEffort::Null;
        add_provider_account(&home, options).unwrap();
        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(!config.contains("model_reasoning_effort"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn claude_gateway_writes_model_catalog_without_reasoning() {
        let home = temporary_home("claude-gateway");
        let mut options = provider_options("claude", "sk-test-claude");
        options.base_url = "https://claude-gateway.example.com/v1".into();
        options.model = "claude-sonnet-4-5".into();
        options.provider_kind = "claude-responses".into();
        options.reasoning_effort = ReasoningEffort::Null;
        add_provider_account(&home, options).unwrap();

        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(config.contains("model = \"claude-sonnet-4-5\""));
        assert!(config.contains("model_catalog_json"));
        assert!(!config.contains("model_reasoning_effort"));
        assert!(config.contains("name = \"Claude via Responses\""));

        let catalog = fs::read_to_string(home.join("accounts/model-catalogs/claude.json")).unwrap();
        assert!(catalog.contains("\"supports_parallel_tool_calls\": false"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn native_anthropic_endpoint_is_rejected() {
        let home = temporary_home("native-anthropic");
        let mut options = provider_options("claude", "sk-ant-test");
        options.base_url = "https://api.anthropic.com/v1".into();
        options.model = "claude-sonnet-4-5".into();
        options.provider_kind = "claude-responses".into();
        let error = add_provider_account(&home, options).unwrap_err();
        assert!(error.contains("Responses-compatible Claude gateway"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn provider_config_avoids_existing_and_reserved_ids() {
        let home = temporary_home("provider-conflict");
        fs::write(
            home.join("config.toml"),
            "[model_providers.claude]\nname = \"User Claude\"\nbase_url = \"https://user.example.com/v1\"\n",
        )
        .unwrap();
        let mut options = provider_options("claude", "sk-test-conflict");
        options.model = "claude-sonnet-4-5".into();
        options.provider_kind = "claude-responses".into();
        add_provider_account(&home, options).unwrap();
        let config = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(config.contains("model_provider = \"claude-codex-auth\""));
        assert_eq!(config.matches("[model_providers.claude]").count(), 1);
        assert!(config.contains("[model_providers.claude-codex-auth]"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn reasoning_input_distinguishes_missing_null_and_value() {
        let missing: AddProviderOptions = serde_json::from_value(json!({})).unwrap();
        let null: AddProviderOptions =
            serde_json::from_value(json!({ "reasoningEffort": null })).unwrap();
        let value: AddProviderOptions =
            serde_json::from_value(json!({ "reasoningEffort": "high" })).unwrap();
        assert!(matches!(missing.reasoning_effort, ReasoningEffort::Missing));
        assert!(matches!(null.reasoning_effort, ReasoningEffort::Null));
        assert!(
            matches!(value.reasoning_effort, ReasoningEffort::Value(ref item) if item == "high")
        );
    }

    #[test]
    fn chatgpt_login_clears_provider_overrides() {
        let home = temporary_home("chatgpt");
        add_provider_account(&home, provider_options("apiz", "sk-provider")).unwrap();
        let token = fake_id_token("Person@Example.com", "user-1", "account-1");
        let (registry, email) =
            persist_chatgpt_login(&home, token, "access-token".into(), "refresh-token".into())
                .unwrap();
        assert_eq!(email.as_deref(), Some("person@example.com"));
        assert_eq!(
            registry.active_account_key.as_deref(),
            Some("user-1::account-1")
        );
        assert_eq!(registry.accounts.len(), 2);
        assert!(!fs::read_to_string(home.join("config.toml"))
            .unwrap()
            .contains(HEAD_BEGIN));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn switching_and_removing_accounts_keeps_a_valid_active_snapshot() {
        let home = temporary_home("switch-remove");
        let first = add_provider_account(&home, provider_options("one", "sk-one")).unwrap();
        let first_key = first.active_account_key.unwrap();
        let second = add_provider_account(&home, provider_options("two", "sk-two")).unwrap();
        let second_key = second.active_account_key.unwrap();

        let switched = switch_account(&home, &first_key).unwrap();
        assert_eq!(
            switched.active_account_key.as_deref(),
            Some(first_key.as_str())
        );
        let auth = read_auth_value(&active_auth_path(&home)).unwrap();
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(Value::as_str),
            Some("sk-one")
        );

        let remaining = remove_account(&home, &first_key).unwrap();
        assert_eq!(
            remaining.active_account_key.as_deref(),
            Some(second_key.as_str())
        );
        let auth = read_auth_value(&active_auth_path(&home)).unwrap();
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(Value::as_str),
            Some("sk-two")
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn export_import_round_trip_preserves_provider_account() {
        let source = temporary_home("export-source");
        add_provider_account(&source, provider_options("roundtrip", "sk-roundtrip")).unwrap();
        let (payload, exported, missing, scope) = build_export_payload(&source, None).unwrap();
        assert_eq!(exported, 1);
        assert!(missing.is_empty());
        assert_eq!(scope, "all");

        let destination = temporary_home("export-destination");
        let result = import_payload(&destination, payload);
        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(true));
        let imported = load_registry(&destination).unwrap();
        assert_eq!(imported.accounts.len(), 1);
        assert_eq!(
            imported.accounts[0].provider.as_ref().unwrap().model,
            DEFAULT_PROVIDER_MODEL
        );
        assert!(account_auth_path(&destination, &imported.accounts[0].account_key).exists());
        let _ = fs::remove_dir_all(source);
        let _ = fs::remove_dir_all(destination);
    }
}
