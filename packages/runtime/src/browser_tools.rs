//! task-993 / verdict-989 方案 B：Runtime 原生浏览工具面（最小切片）。
//!
//! 只暴露四个工具 —— `browser_navigate` / `browser_snapshot` / `browser_click` /
//! `browser_take_screenshot`。驱动是成熟 CDP 客户端 `chromiumoxide`，不写自研
//! 浏览器协议层；点击 / 快照的 ref 表示是薄薄一层 DOM 标注（`data-xihe-ref`），
//! 属于「工具面语义」而不是第二套浏览器实现。
//!
//! 安全口径（与 CP `PolicyEngine` 的 ASK 地板配套）：
//! - 浏览器跑在**宿主**（MXC 之外），默认不隔离；产品文案不得宣称安全边界。
//! - 只允许 `http` / `https`，并按 origin allowlist 校验；`file:` / `about:` /
//!   `chrome:` 一律拒（`BROWSER_ORIGIN_BLOCKED`）。allowlist 为空 ⇒ 全部拒。
//! - 失败一律带稳定错误码前缀，UI/审计可以解析，不允许静默变「没有工具」。
//! - 截图只落 artifact 文件并回引用 + 缩略预览，原始 PNG 不进模型/durable。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::page::ScreenshotParams;
use futures_util::StreamExt;
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

// The name constants and the census below are consumed by the tool-router regression
// tests and the evidence ledger, not by a runtime code path.
#[allow(dead_code)]
pub const TOOL_NAVIGATE: &str = "browser_navigate";
#[allow(dead_code)]
pub const TOOL_SNAPSHOT: &str = "browser_snapshot";
#[allow(dead_code)]
pub const TOOL_CLICK: &str = "browser_click";
#[allow(dead_code)]
pub const TOOL_SCREENSHOT: &str = "browser_take_screenshot";

/// The complete browser surface. Anything outside this list must never be exposed.
#[allow(dead_code)]
pub const BROWSER_TOOL_NAMES: [&str; 4] =
    [TOOL_NAVIGATE, TOOL_SNAPSHOT, TOOL_CLICK, TOOL_SCREENSHOT];

pub const ERROR_NOT_INSTALLED: &str = "BROWSER_NOT_INSTALLED";
pub const ERROR_ORIGIN_BLOCKED: &str = "BROWSER_ORIGIN_BLOCKED";
pub const ERROR_NAV_FAILED: &str = "BROWSER_NAV_FAILED";
pub const ERROR_TARGET_NOT_FOUND: &str = "BROWSER_TARGET_NOT_FOUND";
pub const ERROR_LAUNCH_FAILED: &str = "BROWSER_LAUNCH_FAILED";
pub const ERROR_NOT_READY: &str = "BROWSER_NOT_READY";
pub const ERROR_TIMEOUT: &str = "BROWSER_TIMEOUT";
pub const ERROR_SCREENSHOT_FAILED: &str = "BROWSER_SCREENSHOT_FAILED";

/// Env knobs (registered in evidence README; kept local to the MVP surface).
pub const ENV_EXECUTABLE: &str = "XIHE_BROWSER_EXECUTABLE";
pub const ENV_ALLOWED_ORIGINS: &str = "XIHE_BROWSER_ALLOWED_ORIGINS";

const SNAPSHOT_MAX_CHARS: usize = 8_000;
const NAV_TIMEOUT: Duration = Duration::from_secs(20);
const OP_TIMEOUT: Duration = Duration::from_secs(10);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);

#[allow(dead_code)]
pub fn is_browser_tool(name: &str) -> bool {
    BROWSER_TOOL_NAMES.contains(&name)
}

/// Stable error rendering: `CODE: message`. The code is the first token, so callers
/// (UI card, audit, tests) can match on it without parsing prose.
#[derive(Debug)]
pub struct BrowserError {
    pub code: &'static str,
    pub message: String,
}

impl BrowserError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn render(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

type BrowserResult<T> = Result<T, BrowserError>;

/// Candidate browser binaries, in product preference order. System Edge/Chrome only —
/// no bundled Chromium in the MVP (verdict-989 §7-3).
fn candidate_executables() -> Vec<PathBuf> {
    if let Ok(explicit) = std::env::var(ENV_EXECUTABLE) {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return vec![PathBuf::from(trimmed)];
        }
    }
    #[allow(unused_mut)]
    let mut candidates: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        for path in [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ] {
            candidates.push(PathBuf::from(path));
        }
    }
    #[cfg(not(windows))]
    {
        for name in [
            "google-chrome",
            "chromium",
            "chromium-browser",
            "microsoft-edge",
        ] {
            candidates.push(PathBuf::from(name));
        }
    }
    candidates
}

fn resolve_executable() -> BrowserResult<PathBuf> {
    for candidate in candidate_executables() {
        if candidate.is_absolute() {
            if candidate.is_file() {
                return Ok(candidate);
            }
            continue;
        }
        if let Some(found) = find_on_path(&candidate) {
            return Ok(found);
        }
    }
    Err(BrowserError::new(
        ERROR_NOT_INSTALLED,
        "no system Edge/Chrome found; set XIHE_BROWSER_EXECUTABLE to a Chromium-compatible binary",
    ))
}

fn find_on_path(name: &Path) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let with_exe = dir.join(format!("{}.exe", name.display()));
            if with_exe.is_file() {
                return Some(with_exe);
            }
        }
    }
    None
}

/// Parse one allowlist entry (`scheme://host[:port]`) into its normalized origin.
fn normalize_origin(raw: &str) -> Option<String> {
    let parsed = url::Url::parse(raw.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let port = parsed.port_or_known_default()?;
    Some(format!("{}://{}:{}", parsed.scheme(), host, port))
}

/// Validate a navigation target against the configured origin allowlist.
///
/// Returns the normalized URL string on success. An empty allowlist blocks everything —
/// fail closed, not "allow by default".
pub fn check_origin(raw_url: &str, allowed_origins: &[String]) -> BrowserResult<String> {
    let trimmed = raw_url.trim();
    let parsed = url::Url::parse(trimmed).map_err(|error| {
        BrowserError::new(ERROR_ORIGIN_BLOCKED, format!("unparsable url ({error})"))
    })?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(BrowserError::new(
                ERROR_ORIGIN_BLOCKED,
                format!("scheme '{other}' is not allowed; only http/https"),
            ));
        }
    }
    let origin = normalize_origin(trimmed)
        .ok_or_else(|| BrowserError::new(ERROR_ORIGIN_BLOCKED, "url has no usable origin"))?;
    if allowed_origins.is_empty() {
        return Err(BrowserError::new(
            ERROR_ORIGIN_BLOCKED,
            format!("origin allowlist is empty; set {ENV_ALLOWED_ORIGINS} to permit {origin}"),
        ));
    }
    if !allowed_origins.iter().any(|allowed| allowed == &origin) {
        return Err(BrowserError::new(
            ERROR_ORIGIN_BLOCKED,
            format!("origin {origin} is not in the allowlist"),
        ));
    }
    Ok(parsed.to_string())
}

fn truncate_chars(text: &str, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        return (text.to_string(), false);
    }
    let truncated: String = text.chars().take(limit).collect();
    (truncated, true)
}

/// A snapshot ref is `r` followed by at least one digit. Anything else (including the
/// bare `r` and CSS selectors such as `[role]`) stays a selector.
fn is_ref_shaped(raw: &str) -> bool {
    raw.len() > 1 && raw.starts_with('r') && raw[1..].chars().all(|c| c.is_ascii_digit())
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NavigateOutcome {
    pub url: String,
    pub title: String,
    pub note: String,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOutcome {
    pub url: String,
    pub title: String,
    pub text: String,
    pub truncated: bool,
    pub refs: usize,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClickOutcome {
    pub target: String,
    pub url: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOutcome {
    pub artifact_path: String,
    pub relative_path: String,
    pub bytes: usize,
    /// Small JPEG data URL preview (bounded), never the raw PNG.
    pub preview_data_url: String,
}

struct Session {
    #[allow(dead_code)] // kept alive so chromiumoxide's Drop terminates the child process
    browser: Browser,
    page: chromiumoxide::page::Page,
    handler: tokio::task::JoinHandle<()>,
    refs: HashMap<String, String>,
    last_url: String,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.handler.abort();
    }
}

/// task-1008: the page belongs to the **Xihe session**, never to the MCP protocol
/// session. CP→Runtime is deliberately stateless (decision #34) and opens a fresh
/// MCP session per tool call, so a page owned by the per-MCP-session `XiheRuntime`
/// died between `navigate` and `snapshot` (`BROWSER_NOT_READY`). The registry keys
/// the page by `(workspaceId, X-Session-Id)` and hands out clones that share one
/// page slot.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct BrowserSessionKey {
    pub workspace_id: String,
    pub session_id: String,
}

impl BrowserSessionKey {
    pub fn new(workspace_id: impl Into<String>, session_id: impl Into<String>) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
        }
    }
}

/// Env knob: upper bound on live pages (LRU eviction once exceeded). Default 16.
pub const ENV_MAX_SESSIONS: &str = "XIHE_BROWSER_MAX_SESSIONS";
/// Env knob: idle TTL in seconds for a page. Default 900 (15 min).
pub const ENV_SESSION_IDLE_SECS: &str = "XIHE_BROWSER_SESSION_IDLE_SECS";

const DEFAULT_MAX_SESSIONS: usize = 16;
const DEFAULT_SESSION_IDLE: Duration = Duration::from_secs(900);

struct RegistryEntry {
    tools: BrowserTools,
    last_used: Instant,
}

/// Process-level page registry (task-1008). One entry per `(workspace, session)`, with a
/// bounded lifecycle: entries idle longer than the TTL, or beyond the capacity, are evicted
/// (dropping the last handle closes the chromium child via `Session::drop`).
pub struct BrowserSessionRegistry {
    entries: std::sync::Mutex<HashMap<BrowserSessionKey, RegistryEntry>>,
    max_entries: usize,
    idle_ttl: Duration,
}

impl Default for BrowserSessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserSessionRegistry {
    pub fn new() -> Self {
        let max_entries = std::env::var(ENV_MAX_SESSIONS)
            .ok()
            .and_then(|raw| raw.trim().parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_MAX_SESSIONS);
        let idle_ttl = std::env::var(ENV_SESSION_IDLE_SECS)
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_SESSION_IDLE);
        Self::with_limits(max_entries, idle_ttl)
    }

    /// Explicit limits (tests and acceptance runs).
    pub fn with_limits(max_entries: usize, idle_ttl: Duration) -> Self {
        Self {
            entries: std::sync::Mutex::new(HashMap::new()),
            max_entries: max_entries.max(1),
            idle_ttl,
        }
    }

    /// Returns the handle for `key`, building it on first use. The returned value shares
    /// the page slot with every other handle for the same key, so navigate/snapshot/click/
    /// screenshot compose even when they arrive through different MCP protocol sessions.
    ///
    /// Lifecycle runs here (the only entry point): expired entries are swept, and if the
    /// registry is still at capacity the least-recently-used entry is evicted to make room.
    pub fn tools_for<F>(&self, key: BrowserSessionKey, build: F) -> BrowserTools
    where
        F: FnOnce() -> BrowserTools,
    {
        let now = Instant::now();
        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.retain(|_, entry| now.duration_since(entry.last_used) < self.idle_ttl);
        if let Some(entry) = guard.get_mut(&key) {
            entry.last_used = now;
            return entry.tools.clone();
        }
        if guard.len() >= self.max_entries {
            if let Some(oldest) = guard
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            {
                guard.remove(&oldest);
            }
        }
        let tools = build();
        guard.insert(
            key,
            RegistryEntry {
                tools: tools.clone(),
                last_used: now,
            },
        );
        tools
    }

    #[allow(dead_code)] // registry bookkeeping read in tests and the evidence run
    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    /// Force-remove one key (used by teardown/tests; dropping the last handle closes the page).
    #[allow(dead_code)]
    pub fn remove(&self, key: &BrowserSessionKey) -> bool {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(key)
            .is_some()
    }
}

/// The single process-wide registry. Keyed by workspace + session, so a Runtime
/// restart is the only thing that drops pages (documented residual in the evidence).
pub fn browser_sessions() -> &'static BrowserSessionRegistry {
    static REGISTRY: std::sync::OnceLock<BrowserSessionRegistry> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(BrowserSessionRegistry::new)
}

/// Per-runtime-instance browser session. Serialized by a mutex: a session has one page,
/// so concurrent tool calls queue instead of racing.
#[derive(Clone)]
pub struct BrowserTools {
    workspace: PathBuf,
    allowed_origins: Vec<String>,
    session: Arc<Mutex<Option<Session>>>,
}

impl BrowserTools {
    pub fn new(workspace: impl AsRef<Path>) -> Self {
        let allowed_origins = std::env::var(ENV_ALLOWED_ORIGINS)
            .ok()
            .map(|raw| {
                raw.split(',')
                    .filter_map(normalize_origin)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Self::with_origins(workspace, allowed_origins)
    }

    /// Explicit-origin constructor (tests and future workspace-level config wiring).
    pub fn with_origins(workspace: impl AsRef<Path>, allowed_origins: Vec<String>) -> Self {
        Self {
            workspace: workspace.as_ref().to_path_buf(),
            allowed_origins,
            session: Arc::new(Mutex::new(None)),
        }
    }

    async fn ensure_session(&self, slot: &mut Option<Session>) -> BrowserResult<()> {
        if slot.is_none() {
            *slot = Some(launch_session(&self.workspace).await?);
        }
        if slot.is_some() {
            Ok(())
        } else {
            Err(BrowserError::new(
                ERROR_LAUNCH_FAILED,
                "browser session unavailable after launch",
            ))
        }
    }

    pub async fn navigate(&self, url: &str) -> BrowserResult<NavigateOutcome> {
        let target = check_origin(url, &self.allowed_origins)?;
        let mut guard = self.session.lock().await;
        self.ensure_session(&mut guard).await?;
        let session = guard
            .as_mut()
            .ok_or_else(|| BrowserError::new(ERROR_LAUNCH_FAILED, "browser session unavailable"))?;
        let nav = tokio::time::timeout(NAV_TIMEOUT, session.page.goto(target.clone())).await;
        match nav {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                *guard = None;
                return Err(BrowserError::new(ERROR_NAV_FAILED, error.to_string()));
            }
            Err(_) => {
                *guard = None;
                return Err(BrowserError::new(
                    ERROR_TIMEOUT,
                    format!("navigation to {target} exceeded {}s", NAV_TIMEOUT.as_secs()),
                ));
            }
        }
        // Redirects are re-validated: the allowlist gates every hop we can observe.
        let final_url = session
            .page
            .url()
            .await
            .ok()
            .flatten()
            .unwrap_or(target.clone());
        check_origin(&final_url, &self.allowed_origins).map_err(|error| {
            BrowserError::new(
                ERROR_ORIGIN_BLOCKED,
                format!("redirect landed outside the allowlist: {}", error.message),
            )
        })?;
        session.last_url = final_url.clone();
        session.refs.clear();
        let title = page_title(session).await;
        Ok(NavigateOutcome {
            url: final_url,
            title,
            note: "browser runs on the host process (not inside the MXC sandbox): default is not isolated"
                .to_string(),
        })
    }

    pub async fn snapshot(&self) -> BrowserResult<SnapshotOutcome> {
        let mut guard = self.session.lock().await;
        let session = guard
            .as_mut()
            .ok_or_else(|| BrowserError::new(ERROR_NOT_READY, "navigate first; no page is open"))?;
        let raw = evaluate(session, SNAPSHOT_JS).await.map_err(|error| {
            BrowserError::new(ERROR_NOT_READY, format!("snapshot failed: {error}"))
        })?;
        let parsed: SnapshotPayload = serde_json::from_value(raw).map_err(|error| {
            BrowserError::new(
                ERROR_NOT_READY,
                format!("snapshot payload unreadable: {error}"),
            )
        })?;
        session.refs = parsed
            .refs
            .iter()
            .map(|entry| (entry.ref_id.clone(), entry.selector.clone()))
            .collect();
        let (text, truncated) = truncate_chars(&parsed.outline, SNAPSHOT_MAX_CHARS);
        let title = page_title(session).await;
        Ok(SnapshotOutcome {
            url: session.last_url.clone(),
            title,
            text,
            truncated,
            refs: session.refs.len(),
        })
    }

    pub async fn click(&self, target: &str) -> BrowserResult<ClickOutcome> {
        let trimmed = target.trim();
        if trimmed.is_empty() {
            return Err(BrowserError::new(
                ERROR_TARGET_NOT_FOUND,
                "target is empty; pass a ref from browser_snapshot or a CSS selector",
            ));
        }
        let mut guard = self.session.lock().await;
        let session = guard.as_mut().ok_or_else(|| {
            BrowserError::new(
                ERROR_NOT_READY,
                "navigate and snapshot first; no page is open",
            )
        })?;
        let selector = if let Some(selector) = session.refs.get(trimmed) {
            selector.clone()
        } else if is_ref_shaped(trimmed) {
            return Err(BrowserError::new(
                ERROR_TARGET_NOT_FOUND,
                format!("ref '{trimmed}' is not in the current snapshot; re-run browser_snapshot"),
            ));
        } else {
            trimmed.to_string()
        };
        let clicked = tokio::time::timeout(OP_TIMEOUT, async {
            let element = session.page.find_element(selector.clone()).await?;
            element.click().await.map(|_| ())
        })
        .await;
        match clicked {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                return Err(BrowserError::new(
                    ERROR_TARGET_NOT_FOUND,
                    format!("no clickable element for target '{trimmed}': {error}"),
                ));
            }
            Err(_) => {
                return Err(BrowserError::new(
                    ERROR_TIMEOUT,
                    format!("click on '{trimmed}' exceeded {}s", OP_TIMEOUT.as_secs()),
                ));
            }
        }
        let url = session
            .page
            .url()
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| session.last_url.clone());
        if url != session.last_url {
            check_origin(&url, &self.allowed_origins)?;
            session.last_url = url.clone();
            session.refs.clear();
        }
        let title = page_title(session).await;
        Ok(ClickOutcome {
            target: trimmed.to_string(),
            url,
            title,
        })
    }

    pub async fn screenshot(&self) -> BrowserResult<ScreenshotOutcome> {
        let mut guard = self.session.lock().await;
        let session = guard
            .as_mut()
            .ok_or_else(|| BrowserError::new(ERROR_NOT_READY, "navigate first; no page is open"))?;
        let png = tokio::time::timeout(
            OP_TIMEOUT,
            session.page.screenshot(ScreenshotParams::builder().build()),
        )
        .await;
        let png = match png {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(error)) => {
                return Err(BrowserError::new(
                    ERROR_SCREENSHOT_FAILED,
                    error.to_string(),
                ));
            }
            Err(_) => {
                return Err(BrowserError::new(
                    ERROR_TIMEOUT,
                    format!("screenshot exceeded {}s", OP_TIMEOUT.as_secs()),
                ));
            }
        };
        let artifact_dir = self.workspace.join(".xihe").join("browser-artifacts");
        tokio::fs::create_dir_all(&artifact_dir)
            .await
            .map_err(|error| {
                BrowserError::new(ERROR_SCREENSHOT_FAILED, format!("artifact dir: {error}"))
            })?;
        let name = format!("browser-{}.png", uuid::Uuid::now_v7());
        let path = artifact_dir.join(&name);
        tokio::fs::write(&path, &png).await.map_err(|error| {
            BrowserError::new(ERROR_SCREENSHOT_FAILED, format!("write artifact: {error}"))
        })?;
        let relative = format!(".xihe/browser-artifacts/{name}");
        let preview = small_preview(session).await.unwrap_or_default();
        Ok(ScreenshotOutcome {
            artifact_path: path.to_string_lossy().to_string(),
            relative_path: relative,
            bytes: png.len(),
            preview_data_url: preview,
        })
    }

    /// Drop the current session (used by tests and by a future idle reaper).
    #[allow(dead_code)]
    pub async fn shutdown(&self) {
        let mut guard = self.session.lock().await;
        guard.take();
    }
}

async fn launch_session(workspace: &Path) -> BrowserResult<Session> {
    let executable = resolve_executable()?;
    let profile_dir = workspace.join(".xihe").join("browser-profile");
    if let Err(error) = tokio::fs::create_dir_all(&profile_dir).await {
        return Err(BrowserError::new(
            ERROR_LAUNCH_FAILED,
            format!("profile dir: {error}"),
        ));
    }
    let config = BrowserConfig::builder()
        .chrome_executable(&executable)
        .user_data_dir(&profile_dir)
        .arg("disable-gpu")
        .arg("no-first-run")
        .arg("no-default-browser-check")
        .arg("disable-extensions")
        .arg("disable-background-networking")
        .arg("mute-audio")
        .arg("hide-scrollbars")
        .no_sandbox()
        .build()
        .map_err(|error| BrowserError::new(ERROR_LAUNCH_FAILED, format!("config: {error}")))?;
    let launched = tokio::time::timeout(LAUNCH_TIMEOUT, Browser::launch(config)).await;
    let (browser, mut handler) = match launched {
        Ok(Ok(pair)) => pair,
        Ok(Err(error)) => {
            return Err(BrowserError::new(
                ERROR_LAUNCH_FAILED,
                format!("launch {}: {error}", executable.display()),
            ));
        }
        Err(_) => {
            return Err(BrowserError::new(
                ERROR_LAUNCH_FAILED,
                format!("launch exceeded {}s", LAUNCH_TIMEOUT.as_secs()),
            ));
        }
    };
    let handler = tokio::spawn(async move {
        while let Some(message) = handler.next().await {
            if message.is_err() {
                break;
            }
        }
    });
    let page = match tokio::time::timeout(LAUNCH_TIMEOUT, browser.new_page("about:blank")).await {
        Ok(Ok(page)) => page,
        Ok(Err(error)) => {
            handler.abort();
            return Err(BrowserError::new(
                ERROR_LAUNCH_FAILED,
                format!("new page: {error}"),
            ));
        }
        Err(_) => {
            handler.abort();
            return Err(BrowserError::new(ERROR_LAUNCH_FAILED, "new page timed out"));
        }
    };
    Ok(Session {
        browser,
        page,
        handler,
        refs: HashMap::new(),
        last_url: "about:blank".to_string(),
    })
}

async fn page_title(session: &Session) -> String {
    session
        .page
        .evaluate_expression("document.title")
        .await
        .ok()
        .and_then(|result| result.into_value::<String>().ok())
        .unwrap_or_default()
}

async fn evaluate(session: &Session, expression: &str) -> Result<Value, String> {
    let result = session
        .page
        .evaluate_expression(expression)
        .await
        .map_err(|error| error.to_string())?;
    result
        .into_value::<Value>()
        .map_err(|error| error.to_string())
}

async fn small_preview(session: &Session) -> Option<String> {
    let size = evaluate(session, "({w: window.innerWidth, h: window.innerHeight})")
        .await
        .ok()?;
    let width = size.get("w")?.as_f64()?;
    let height = size.get("h")?.as_f64()?;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    let params = ScreenshotParams::builder()
        .format(chromiumoxide::cdp::browser_protocol::page::CaptureScreenshotFormat::Jpeg)
        .quality(35)
        .clip(chromiumoxide::cdp::browser_protocol::page::Viewport {
            x: 0.0,
            y: 0.0,
            width,
            height,
            scale: 0.25,
        })
        .build();
    let bytes = session.page.screenshot(params).await.ok()?;
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
    Some(format!("data:image/jpeg;base64,{encoded}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPayload {
    outline: String,
    refs: Vec<SnapshotRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRef {
    #[serde(rename = "ref")]
    ref_id: String,
    selector: String,
}

/// DOM outline + ref tagging. Bounded by construction on the Rust side; the JS side
/// also avoids pulling whole page HTML into the tool result.
const SNAPSHOT_JS: &str = r#"(() => {
  const MAX = 400;
  document.querySelectorAll('[data-xihe-ref]').forEach((el) => el.removeAttribute('data-xihe-ref'));
  const candidates = Array.from(document.querySelectorAll(
    'a,button,input,textarea,select,[role],h1,h2,h3,h4,label,[contenteditable="true"]'
  )).filter((el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  const lines = [];
  const refs = [];
  let index = 0;
  for (const el of candidates) {
    if (index >= MAX) break;
    index += 1;
    const ref = 'r' + index;
    el.setAttribute('data-xihe-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder')
      || (el.innerText || '').trim().split('\n')[0] || '').slice(0, 80);
    const type = el.getAttribute('type') || '';
    const parts = [ref, tag];
    if (role) parts.push('role=' + role);
    if (type) parts.push('type=' + type);
    if (name) parts.push(JSON.stringify(name));
    lines.push(parts.join(' '));
    refs.push({ ref, selector: '[data-xihe-ref="' + ref + '"]' });
  }
  const body = (document.body ? document.body.innerText : '').trim();
  const outline = '# ' + document.title + '\n' + lines.join('\n')
    + '\n--- text ---\n' + body.slice(0, 1200)
    + (body.length > 1200 ? '\n[text truncated]' : '');
  return { outline, refs };
})()"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn origins(list: &[&str]) -> Vec<String> {
        list.iter()
            .filter_map(|raw| normalize_origin(raw))
            .collect()
    }

    #[test]
    fn only_four_tools_are_exported() {
        assert_eq!(BROWSER_TOOL_NAMES.len(), 4);
        for name in BROWSER_TOOL_NAMES {
            assert!(name.starts_with("browser_"));
            assert!(is_browser_tool(name));
        }
        for forbidden in [
            "browser_evaluate",
            "browser_run_code_unsafe",
            "browser_cookie",
        ] {
            assert!(
                !is_browser_tool(forbidden),
                "{forbidden} must stay off the surface"
            );
        }
    }

    #[test]
    fn origin_allowlist_is_fail_closed() {
        let allow = origins(&["http://127.0.0.1:12640"]);
        assert!(check_origin("http://127.0.0.1:12640/login", &allow).is_ok());
        let err = check_origin("http://127.0.0.1:9999/", &allow).unwrap_err();
        assert_eq!(err.code, ERROR_ORIGIN_BLOCKED);
        // Default ports normalize so `https://example.com` and `https://example.com:443` match.
        let https = origins(&["https://example.com"]);
        assert!(check_origin("https://example.com:443/page", &https).is_ok());
    }

    #[test]
    fn empty_allowlist_blocks_everything() {
        let err = check_origin("http://127.0.0.1/", &[]).unwrap_err();
        assert_eq!(err.code, ERROR_ORIGIN_BLOCKED);
        assert!(err.message.contains("allowlist is empty"));
    }

    #[test]
    fn non_http_schemes_are_rejected() {
        let allow = origins(&["https://example.com"]);
        for url in [
            "file:///C:/secret.txt",
            "about:blank",
            "chrome://settings",
            "ftp://example.com",
        ] {
            let err = check_origin(url, &allow).unwrap_err();
            assert_eq!(err.code, ERROR_ORIGIN_BLOCKED, "{url}");
            assert!(
                err.message.contains("not allowed"),
                "{url}: {}",
                err.message
            );
        }
    }

    #[test]
    fn normalize_origin_drops_path_and_rejects_bad_scheme() {
        assert_eq!(
            normalize_origin("http://127.0.0.1:12640/login?x=1"),
            Some("http://127.0.0.1:12640".to_string())
        );
        assert_eq!(normalize_origin("file:///C:/tmp"), None);
        assert_eq!(normalize_origin("not a url"), None);
    }

    #[test]
    fn snapshot_text_is_bounded() {
        let long = "x".repeat(SNAPSHOT_MAX_CHARS + 50);
        let (text, truncated) = truncate_chars(&long, SNAPSHOT_MAX_CHARS);
        assert!(truncated);
        assert_eq!(text.chars().count(), SNAPSHOT_MAX_CHARS);
        let (short, truncated) = truncate_chars("ok", SNAPSHOT_MAX_CHARS);
        assert!(!truncated);
        assert_eq!(short, "ok");
    }

    #[test]
    fn error_render_keeps_code_as_first_token() {
        let error = BrowserError::new(ERROR_TARGET_NOT_FOUND, "nothing here");
        let rendered = error.render();
        assert_eq!(rendered.split(':').next(), Some(ERROR_TARGET_NOT_FOUND));
    }

    #[test]
    fn click_target_classification() {
        // Ref-shaped tokens that are not in the snapshot must fail closed rather than be
        // treated as CSS selectors (which would silently target a different element).
        let looks_like_ref = is_ref_shaped;
        assert!(looks_like_ref("r12"));
        for css in ["#submit", ".btn", "button[type=submit]", "r"] {
            assert!(!looks_like_ref(css), "{css} is a CSS selector, not a ref");
        }
    }

    const PROBE_PAGE: &str = r#"<!doctype html>
<html><head><title>task-993 browser probe</title></head>
<body>
  <h1>Browser probe</h1>
  <span id="status">idle</span>
  <button id="go" onclick="document.getElementById('status').textContent='clicked'">Go</button>
</body></html>"#;

    async fn serve_probe_page() -> (String, tokio::task::JoinHandle<()>) {
        use axum::routing::get;
        let app =
            axum::Router::new().route("/", get(|| async { axum::response::Html(PROBE_PAGE) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind probe listener");
        let port = listener.local_addr().expect("probe addr").port();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://127.0.0.1:{port}"), handle)
    }

    /// The real-browser face: navigate → snapshot → click → snapshot → screenshot.
    ///
    /// Skips only when no Chromium-compatible browser exists; set
    /// `XIHE_BROWSER_TEST_REQUIRED=1` to turn that skip into a failure in acceptance runs.
    #[tokio::test]
    async fn real_browser_navigate_snapshot_click_screenshot() {
        if let Err(error) = resolve_executable() {
            assert_eq!(error.code, ERROR_NOT_INSTALLED);
            if std::env::var("XIHE_BROWSER_TEST_REQUIRED").as_deref() == Ok("1") {
                panic!(
                    "real browser E2E required but no browser is installed: {}",
                    error.message
                );
            }
            eprintln!("SKIP real browser E2E: {}", error.message);
            return;
        }
        let (origin, server) = serve_probe_page().await;
        let allowed = vec![normalize_origin(&origin).expect("probe origin normalizes")];
        let workspace = tempfile::tempdir().expect("temp workspace");
        let tools = BrowserTools::with_origins(workspace.path(), allowed);

        let nav = tools
            .navigate(&format!("{origin}/"))
            .await
            .expect("navigate");
        eprintln!("REAL_BROWSER nav url={} title={}", nav.url, nav.title);
        assert_eq!(nav.title, "task-993 browser probe");
        assert!(
            nav.note.contains("not isolated"),
            "host-mode disclaimer missing"
        );

        let first = tools.snapshot().await.expect("snapshot");
        assert!(
            first.text.contains("idle"),
            "snapshot should expose page text"
        );
        let go_ref = first
            .text
            .lines()
            .find(|line| line.contains("button") && line.contains("\"Go\""))
            .and_then(|line| line.split_whitespace().next())
            .map(str::to_string)
            .expect("button ref present in snapshot");
        assert!(is_ref_shaped(&go_ref), "unexpected ref shape: {go_ref}");

        let click = tools.click(&go_ref).await.expect("click ref");
        assert_eq!(click.target, go_ref);
        let second = tools.snapshot().await.expect("snapshot after click");
        assert!(
            second.text.contains("clicked"),
            "page text must change after click:\n{}",
            second.text
        );

        let shot = tools.screenshot().await.expect("screenshot");
        eprintln!(
            "REAL_BROWSER shot artifact={} bytes={} preview_chars={}",
            shot.artifact_path,
            shot.bytes,
            shot.preview_data_url.len()
        );
        let artifact = std::path::Path::new(&shot.artifact_path);
        assert!(
            artifact.is_file(),
            "artifact file missing: {}",
            shot.artifact_path
        );
        assert!(shot.bytes > 0, "empty screenshot");
        assert!(
            shot.preview_data_url.starts_with("data:image/jpeg;base64,"),
            "preview must be a bounded JPEG data url"
        );
        assert!(
            shot.preview_data_url.len() < 200_000,
            "preview too large: {} bytes",
            shot.preview_data_url.len()
        );
        assert!(shot.relative_path.starts_with(".xihe/browser-artifacts/"));

        tools.shutdown().await;
        server.abort();
    }

    #[tokio::test]
    async fn unlisted_origin_is_rejected_before_any_browser_launch() {
        let (origin, server) = serve_probe_page().await;
        let workspace = tempfile::tempdir().expect("temp workspace");
        let tools = BrowserTools::with_origins(
            workspace.path(),
            vec![normalize_origin("http://127.0.0.1:1").expect("valid origin")],
        );
        let error = tools.navigate(&format!("{origin}/")).await.unwrap_err();
        assert_eq!(error.code, ERROR_ORIGIN_BLOCKED);
        assert!(error.message.contains("not in the allowlist"));
        server.abort();
    }

    /// task-1008 regression: the page must survive **across handles**, because CP opens a new
    /// MCP protocol session per tool call. Two handles for the same `(workspace, session)` key
    /// behave like one page; a different session (or a different workspace) must not see it.
    #[tokio::test]
    async fn registry_shares_one_page_per_session_and_isolates_others() {
        if let Err(error) = resolve_executable() {
            assert_eq!(error.code, ERROR_NOT_INSTALLED);
            if std::env::var("XIHE_BROWSER_TEST_REQUIRED").as_deref() == Ok("1") {
                panic!(
                    "real browser E2E required but no browser is installed: {}",
                    error.message
                );
            }
            eprintln!("SKIP real browser registry E2E: {}", error.message);
            return;
        }
        let (origin, server) = serve_probe_page().await;
        let allowed = vec![normalize_origin(&origin).expect("probe origin normalizes")];
        let workspace = tempfile::tempdir().expect("temp workspace");
        let registry = BrowserSessionRegistry::new();

        let build = || BrowserTools::with_origins(workspace.path(), allowed.clone());
        // Two handles for the SAME key: exactly the shape of two MCP sessions in one Xihe session.
        let first = registry.tools_for(BrowserSessionKey::new("ws-1", "sess-1"), build);
        let second = registry.tools_for(BrowserSessionKey::new("ws-1", "sess-1"), build);

        let nav = first
            .navigate(&format!("{origin}/"))
            .await
            .expect("navigate through handle A");
        assert_eq!(nav.title, "task-993 browser probe");

        // The old failure: this handle never navigated, yet must see the same page.
        let snap = second
            .snapshot()
            .await
            .expect("BROWSER_NOT_READY regression: handle B must see handle A's page");
        assert!(snap.text.contains("idle"), "snapshot text: {}", snap.text);
        let go_ref = snap
            .text
            .lines()
            .find(|line| line.contains("button") && line.contains("\"Go\""))
            .and_then(|line| line.split_whitespace().next())
            .map(str::to_string)
            .expect("button ref present in snapshot");

        let click = second.click(&go_ref).await.expect("click through handle B");
        assert_eq!(click.target, go_ref);
        let after = first
            .snapshot()
            .await
            .expect("snapshot after click through handle A");
        assert!(
            after.text.contains("clicked"),
            "the click from handle B must be visible on handle A:\n{}",
            after.text
        );
        let shot = first
            .screenshot()
            .await
            .expect("screenshot through handle A");
        assert!(shot.bytes > 0, "empty screenshot");
        assert!(std::path::Path::new(&shot.artifact_path).is_file());

        // Isolation: another session in the same workspace, and the same session id in another
        // workspace, must not inherit the page.
        let other_session = registry.tools_for(BrowserSessionKey::new("ws-1", "sess-2"), build);
        let error = other_session.snapshot().await.unwrap_err();
        assert_eq!(error.code, ERROR_NOT_READY, "{}", error.message);
        let other_workspace = registry.tools_for(BrowserSessionKey::new("ws-2", "sess-1"), build);
        let error = other_workspace.snapshot().await.unwrap_err();
        assert_eq!(error.code, ERROR_NOT_READY, "{}", error.message);
        assert_eq!(registry.len(), 3, "one entry per distinct key");

        first.shutdown().await;
        // shutdown on the shared slot is visible through the other handle as well.
        let error = second.snapshot().await.unwrap_err();
        assert_eq!(error.code, ERROR_NOT_READY, "{}", error.message);
        server.abort();
    }

    #[test]
    fn registry_returns_the_same_slot_for_the_same_key_only() {
        let registry = BrowserSessionRegistry::new();
        let a = registry.tools_for(BrowserSessionKey::new("ws", "s1"), || {
            BrowserTools::with_origins(".", Vec::new())
        });
        let b = registry.tools_for(BrowserSessionKey::new("ws", "s1"), || {
            BrowserTools::with_origins(".", Vec::new())
        });
        let c = registry.tools_for(BrowserSessionKey::new("ws", "s2"), || {
            BrowserTools::with_origins(".", Vec::new())
        });
        // Same key ⇒ same shared slot (Arc identity), different key ⇒ distinct slot.
        assert!(Arc::ptr_eq(&a.session, &b.session));
        assert!(!Arc::ptr_eq(&a.session, &c.session));
        assert_eq!(registry.len(), 2);
    }

    /// task-1008 lifecycle: an evicted (capacity or idle-TTL) entry drops its page; the next
    /// navigate for that key launches a fresh browser and works again. Handles are used
    /// per-call (like `XiheRuntime`, which dies with each MCP protocol session).
    #[tokio::test]
    async fn registry_evicts_by_capacity_and_idle_ttl_then_rebuilds_on_navigate() {
        if let Err(error) = resolve_executable() {
            assert_eq!(error.code, ERROR_NOT_INSTALLED);
            if std::env::var("XIHE_BROWSER_TEST_REQUIRED").as_deref() == Ok("1") {
                panic!(
                    "real browser E2E required but no browser is installed: {}",
                    error.message
                );
            }
            eprintln!("SKIP real browser lifecycle E2E: {}", error.message);
            return;
        }
        let (origin, server) = serve_probe_page().await;
        let allowed = vec![normalize_origin(&origin).expect("probe origin normalizes")];
        let workspace = tempfile::tempdir().expect("temp workspace");
        let build = || BrowserTools::with_origins(workspace.path(), allowed.clone());

        // --- capacity eviction (max = 1) -----------------------------------------------------
        let capped = BrowserSessionRegistry::with_limits(1, Duration::from_secs(3600));
        let key_a = BrowserSessionKey::new("ws-cap", "sess-a");
        let key_b = BrowserSessionKey::new("ws-cap", "sess-b");
        {
            let handle = capped.tools_for(key_a.clone(), build);
            let nav = handle
                .navigate(&format!("{origin}/"))
                .await
                .expect("navigate A");
            assert_eq!(nav.title, "task-993 browser probe");
        } // per-call handle drops; only the registry keeps the page alive
        assert_eq!(capped.len(), 1, "one live page before eviction");

        let handle_b = capped.tools_for(key_b, build);
        assert_eq!(capped.len(), 1, "capacity 1: inserting B evicts A");
        drop(handle_b);

        let rebuilt = capped.tools_for(key_a.clone(), build);
        let error = rebuilt.snapshot().await.unwrap_err();
        assert_eq!(
            error.code, ERROR_NOT_READY,
            "the evicted page must be gone, not silently reused: {}",
            error.message
        );
        let nav = rebuilt
            .navigate(&format!("{origin}/"))
            .await
            .expect("navigate after eviction launches a fresh page");
        assert_eq!(nav.title, "task-993 browser probe");
        let snap = rebuilt.snapshot().await.expect("snapshot after rebuild");
        assert!(
            snap.text.contains("idle"),
            "rebuild snapshot: {}",
            snap.text
        );
        rebuilt.shutdown().await;
        drop(rebuilt);
        assert!(capped.remove(&key_a), "explicit teardown removes the entry");
        assert_eq!(capped.len(), 0, "no live pages after teardown");

        // --- idle TTL eviction ---------------------------------------------------------------
        let idle = BrowserSessionRegistry::with_limits(8, Duration::from_millis(150));
        let key_c = BrowserSessionKey::new("ws-ttl", "sess-c");
        {
            let handle = idle.tools_for(key_c.clone(), build);
            handle
                .navigate(&format!("{origin}/"))
                .await
                .expect("navigate C");
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        let after_ttl = idle.tools_for(key_c, build);
        assert_eq!(idle.len(), 1, "a re-entry recreates exactly one entry");
        let error = after_ttl.snapshot().await.unwrap_err();
        assert_eq!(
            error.code, ERROR_NOT_READY,
            "the idle page must have been swept: {}",
            error.message
        );
        let nav = after_ttl
            .navigate(&format!("{origin}/"))
            .await
            .expect("navigate after idle eviction");
        assert_eq!(nav.title, "task-993 browser probe");
        after_ttl.shutdown().await;

        server.abort();
    }
}
