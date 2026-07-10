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
    #[serde(default)]
    pub chatgpt_account_id: String,
    #[serde(default)]
    pub chatgpt_user_id: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
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
    #[serde(default)]
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

#[derive(Debug, Clone, Default)]
pub enum ReasoningEffort {
    #[default]
    Missing,
    Null,
    Value(String),
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

pub fn account_auth_path(codex_home: &Path, account_key: &str) -> PathBuf {
    let file_key = URL_SAFE_NO_PAD.encode(account_key.as_bytes());
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

pub fn load_registry(codex_home: &Path) -> Result<Registry, String> {
    match fs::read_to_string(registry_path(codex_home)) {
        Ok(content) => serde_json::from_str::<Registry>(&content)
            .map_err(|error| format!("Failed to parse registry.json: {error}")),
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
    let content = fs::read_to_string(&source).map_err(|error| error.to_string())?;
    let destination = active_auth_path(codex_home);
    backup_file_if_changed(codex_home, &destination, "auth.json", Some(&content))
        .map_err(|error| error.to_string())?;
    write_private_file(&destination, content).map_err(|error| error.to_string())?;
    set_active_account_key(registry, account_key, false);
    sync_config_for_provider(codex_home, registry.accounts[index].provider.as_ref())
}

pub fn switch_account(codex_home: &Path, account_key: &str) -> Result<Registry, String> {
    let mut registry = load_registry(codex_home)?;
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
    let mut registry = load_registry(codex_home)?;
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
    let _ = fs::remove_file(account_auth_path(codex_home, account_key));
    registry.accounts.remove(index);
    if registry.accounts.is_empty() {
        let _ = fs::remove_file(active_auth_path(codex_home));
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

    let mut registry = load_registry(codex_home)?;
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

    let mut registry = load_registry(codex_home)?;
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

pub fn provider_test_options(
    codex_home: &Path,
    account_key: &str,
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
    let auth = read_account_auth(
        codex_home,
        account_key,
        registry.active_account_key.as_deref(),
    )
    .ok_or_else(|| {
        "The stored API key is missing. Add this API provider account again.".to_string()
    })?;
    let api_key = auth
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "The stored API key is missing. Add this API provider account again.".to_string()
        })?;
    Ok(ProviderTestOptions {
        base_url: provider.base_url.clone(),
        api_key: api_key.to_string(),
        model: provider.model.clone(),
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

pub fn import_payload(codex_home: &Path, payload: Value) -> Value {
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
    let mut registry = load_registry(codex_home).unwrap_or_default();
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
        let Some(auth) = auths.get(&account_key).filter(|value| value.is_object()) else {
            skipped += 1;
            continue;
        };
        let account: Account = match serde_json::from_value(account_value) {
            Ok(account) => account,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let mut serialized = match serde_json::to_string_pretty(auth) {
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
            registry.accounts[index] = account;
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
