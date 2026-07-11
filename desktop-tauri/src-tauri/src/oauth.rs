use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore as _;
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use tauri::AppHandle;
use tauri_plugin_http::reqwest::Client;
use tauri_plugin_opener::OpenerExt as _;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

const ISSUER: &str = "https://auth.openai.com";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const PORT: u16 = 1455;
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const OAUTH_SCOPE: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";

const SUCCESS_HTML: &str = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Accounts for Codex</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0d1017;color:#e6e9ef;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{text-align:center}.check{font-size:42px;color:#4ade80}p{color:#9aa3b2}</style></head>
<body><div class="card"><div class="check">&#10003;</div><h2>Sign-in complete</h2><p>You can close this tab and return to Accounts for Codex.</p></div></body></html>"#;

#[derive(Debug, Clone)]
pub struct OAuthTokens {
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Debug)]
pub enum OAuthOutcome {
    Authorized {
        tokens: OAuthTokens,
        responder: OAuthResponder,
    },
    Cancelled,
}

#[derive(Debug)]
pub struct OAuthResponder(TcpStream);

impl OAuthResponder {
    pub async fn success(mut self) {
        write_response(
            &mut self.0,
            "200 OK",
            "text/html; charset=utf-8",
            SUCCESS_HTML,
        )
        .await;
    }

    pub async fn failure(mut self, error: &str) {
        let html = format!("<h2>Sign-in failed</h2><p>{}</p>", escape_html(error));
        write_response(
            &mut self.0,
            "500 Internal Server Error",
            "text/html; charset=utf-8",
            &html,
        )
        .await;
    }
}

#[derive(Default)]
pub struct LoginCoordinator {
    cancel: Mutex<Option<watch::Sender<bool>>>,
}

impl LoginCoordinator {
    fn begin(&self) -> Result<watch::Receiver<bool>, String> {
        let mut active = self
            .cancel
            .lock()
            .map_err(|_| "Login state is unavailable.".to_string())?;
        if active.is_some() {
            return Err("A login is already in progress.".into());
        }
        let (sender, receiver) = watch::channel(false);
        *active = Some(sender);
        Ok(receiver)
    }

    fn finish(&self) {
        if let Ok(mut active) = self.cancel.lock() {
            *active = None;
        }
    }

    pub fn cancel(&self) -> bool {
        let Ok(active) = self.cancel.lock() else {
            return false;
        };
        active
            .as_ref()
            .is_some_and(|sender| sender.send(true).is_ok())
    }
}

fn random_base64(byte_count: usize) -> String {
    let mut bytes = vec![0_u8; byte_count];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

async fn write_response(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn request_path(stream: &mut TcpStream) -> Result<String, String> {
    let mut buffer = vec![0_u8; 16 * 1024];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer))
        .await
        .map_err(|_| "Login callback timed out.".to_string())?
        .map_err(|error| error.to_string())?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let first_line = request
        .lines()
        .next()
        .ok_or_else(|| "Invalid login callback.".to_string())?;
    let mut parts = first_line.split_whitespace();
    if parts.next() != Some("GET") {
        return Err("Invalid login callback method.".into());
    }
    parts
        .next()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Invalid login callback path.".to_string())
}

async fn bind_callback_listener(client: &Client) -> Result<TcpListener, String> {
    match TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(listener) => return Ok(listener),
        Err(error) if error.kind() != std::io::ErrorKind::AddrInUse => {
            return Err(error.to_string())
        }
        Err(_) => {}
    }
    let _ = client
        .get(format!("http://127.0.0.1:{PORT}/cancel"))
        .timeout(Duration::from_secs(2))
        .send()
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    TcpListener::bind(("127.0.0.1", PORT))
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AddrInUse {
                format!("Port {PORT} is in use by another login flow. Close it and try again.")
            } else {
                error.to_string()
            }
        })
}

async fn exchange_code(client: &Client, code: &str, verifier: &str) -> Result<OAuthTokens, String> {
    let response = client
        .post(format!("{ISSUER}/oauth/token"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(30))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", CLIENT_ID),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "Token exchange timed out after 30 seconds.".to_string()
            } else {
                format!("Token exchange transport failed: {error}")
            }
        })?;
    let status = response.status();
    let cloudflare_blocked = response
        .headers()
        .get("cf-mitigated")
        .and_then(|value| value.to_str().ok())
        == Some("challenge");
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = body
            .get("error_description")
            .or_else(|| body.get("message"))
            .and_then(Value::as_str)
            .or_else(|| body.get("error").and_then(Value::as_str))
            .unwrap_or_default();
        let hint = if cloudflare_blocked {
            " Cloudflare blocked the token request. Check VPN/proxy settings for auth.openai.com."
        } else if status.as_u16() == 403 {
            " The app could not reach auth.openai.com through your network proxy. Ensure system proxy settings allow this domain."
        } else {
            ""
        };
        return Err(format!(
            "Token exchange failed (HTTP {}){}{}",
            status.as_u16(),
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            },
            hint
        ));
    }
    let id_token = body
        .get("id_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Token exchange response was missing tokens.".to_string())?;
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Token exchange response was missing tokens.".to_string())?;
    Ok(OAuthTokens {
        id_token: id_token.to_string(),
        access_token: access_token.to_string(),
        refresh_token: body
            .get("refresh_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

async fn browser_login_inner(
    client: &Client,
    app: &AppHandle,
    mut cancel: watch::Receiver<bool>,
) -> Result<OAuthOutcome, String> {
    let listener = bind_callback_listener(client).await?;
    let verifier = random_base64(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_base64(32);
    let mut auth_url =
        url::Url::parse(&format!("{ISSUER}/oauth/authorize")).map_err(|error| error.to_string())?;
    auth_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", OAUTH_SCOPE)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", &state)
        .append_pair("originator", "codex_cli_rs");
    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|error| format!("Could not open the sign-in page: {error}"))?;

    let timeout = tokio::time::sleep(Duration::from_secs(10 * 60));
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            _ = &mut timeout => return Err("Sign-in timed out after 10 minutes.".into()),
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    return Ok(OAuthOutcome::Cancelled);
                }
            }
            accepted = listener.accept() => {
                let (mut stream, _) = accepted.map_err(|error| error.to_string())?;
                let path = match request_path(&mut stream).await {
                    Ok(path) => path,
                    Err(error) => {
                        write_response(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", &error).await;
                        continue;
                    }
                };
                let url = match url::Url::parse(&format!("http://localhost:{PORT}{path}")) {
                    Ok(url) => url,
                    Err(_) => {
                        write_response(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", "Invalid callback URL.").await;
                        continue;
                    }
                };
                if url.path() == "/cancel" {
                    write_response(&mut stream, "200 OK", "text/plain; charset=utf-8", "Login cancelled.").await;
                    return Ok(OAuthOutcome::Cancelled);
                }
                if url.path() != "/auth/callback" {
                    write_response(&mut stream, "404 Not Found", "text/plain; charset=utf-8", "Not found.").await;
                    continue;
                }
                let query = url.query_pairs().collect::<std::collections::HashMap<_, _>>();
                if query.get("state").map(|value| value.as_ref()) != Some(state.as_str()) {
                    write_response(&mut stream, "400 Bad Request", "text/html; charset=utf-8", "<h2>State mismatch</h2><p>Restart the sign-in from Accounts for Codex.</p>").await;
                    return Err("Login callback state mismatch — try again.".into());
                }
                let Some(code) = query.get("code") else {
                    let detail = query
                        .get("error_description")
                        .or_else(|| query.get("error"))
                        .map(|value| value.as_ref())
                        .unwrap_or("missing authorization code");
                    let html = format!("<h2>Sign-in failed</h2><p>{}</p>", escape_html(detail));
                    write_response(&mut stream, "400 Bad Request", "text/html; charset=utf-8", &html).await;
                    return Err(format!("Sign-in failed: {detail}"));
                };
                match exchange_code(client, code, &verifier).await {
                    Ok(tokens) => {
                        return Ok(OAuthOutcome::Authorized {
                            tokens,
                            responder: OAuthResponder(stream),
                        });
                    }
                    Err(error) => {
                        let html = format!("<h2>Sign-in failed</h2><p>{}</p>", escape_html(&error));
                        write_response(&mut stream, "500 Internal Server Error", "text/html; charset=utf-8", &html).await;
                        return Err(error);
                    }
                }
            }
        }
    }
}

pub async fn browser_login(
    client: &Client,
    coordinator: &LoginCoordinator,
    app: &AppHandle,
) -> Result<OAuthOutcome, String> {
    let cancel = coordinator.begin()?;
    let result = browser_login_inner(client, app, cancel).await;
    coordinator.finish();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn connected_streams() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = TcpStream::connect(address).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        (server, client)
    }

    #[tokio::test]
    async fn responder_does_not_report_success_before_it_is_consumed() {
        let (server, mut client) = connected_streams().await;
        let responder = OAuthResponder(server);
        let mut byte = [0_u8; 1];

        assert!(
            tokio::time::timeout(Duration::from_millis(50), client.read(&mut byte))
                .await
                .is_err()
        );

        responder.success().await;
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Sign-in complete"));
    }

    #[tokio::test]
    async fn responder_reports_persistence_failures_without_a_success_page() {
        let (server, mut client) = connected_streams().await;
        OAuthResponder(server)
            .failure("Could not save <registry> & \"auth\".")
            .await;

        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 500 Internal Server Error"));
        assert!(response.contains("Could not save &lt;registry&gt; &amp; &quot;auth&quot;."));
        assert!(!response.contains("Sign-in complete"));
    }
}
