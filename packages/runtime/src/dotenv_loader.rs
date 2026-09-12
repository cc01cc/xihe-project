//! Module-local env chain loader (PLAN-0307 T3.1/T3.5; spec/config-env-target §1.2/§1.5).
//!
//! Single-authority loader for the Runtime module: CLI `--set` > process env snapshot >
//! file chain (`.env` → `.env.$XIHE_ENV` → `.env.local`) > code default.
//! `scripts/run-with-log.sh` no longer sources env files.
//!
//! NOTE: callers must invoke [`load`] before starting threads (see `main`), so the
//! process-env writes stay on the single main thread (`std::env::set_var` safety).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

const MAX_DEPTH: u32 = 5;
const BOOTSTRAP_ENV_KEY: &str = "XIHE_ENV";
const LOAD_DOTENV_KEY: &str = "XIHE_LOAD_DOTENV";
const ENV_FILE_KEY: &str = "XIHE_ENV_FILE";
const ROOT_MARKERS: [&str; 5] = [".env", ".env.dev", ".env.test", ".env.prod", ".env.example"];

/// §1.5: undefined interpolation escalates from WARN to ERROR for fail-fast keys.
const CRITICAL_KEYS: [&str; 5] = [
    "XIHE_CP_JWT_SECRET",
    "XIHE_CP_API_TOKEN",
    "XIHE_AGENT_API_TOKEN",
    "XIHE_CP_OAUTH_ENCRYPTION_KEY",
    "XIHE_CP_PROVIDER_CREDENTIALS_KEY",
];

static INTERPOLATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")
        .expect("env interpolation regex must compile")
});

static DEFAULT_FORM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}")
        .expect("env default-form regex must compile")
});

/// Parse `--set KEY=VALUE` / `--set=KEY=VALUE` pairs (values may contain '=').
pub fn parse_cli_overrides(args: &[String]) -> Result<HashMap<String, String>, String> {
    let mut overrides = HashMap::new();
    let mut index = 0;
    while index < args.len() {
        let token = args[index].as_str();
        let pair = if token == "--set" && index + 1 < args.len() {
            index += 2;
            Some(args[index - 1].as_str())
        } else if let Some(rest) = token.strip_prefix("--set=") {
            index += 1;
            Some(rest)
        } else {
            index += 1;
            None
        };
        let Some(pair) = pair else { continue };
        let Some((key, value)) = pair.split_once('=') else {
            return Err(format!("--set expects KEY=VALUE, got: {pair}"));
        };
        overrides.insert(key.trim().to_string(), value.to_string());
    }
    Ok(overrides)
}

/// Resolve `${VAR}` / `${VAR:-default}`; undefined without default → WARN + empty.
pub fn interpolate(value: &str, lookup: &HashMap<String, String>) -> String {
    INTERPOLATION
        .replace_all(value, |caps: &regex::Captures<'_>| {
            let name = &caps[1];
            if let Some(found) = lookup.get(name) {
                return found.clone();
            }
            if let Some(default) = caps.get(2) {
                return default.as_str().to_string();
            }
            if CRITICAL_KEYS.contains(&name) {
                tracing::error!(
                    key = name,
                    "Undefined variable in env interpolation (resolved to empty string)"
                );
            } else {
                tracing::warn!(
                    key = name,
                    "Undefined variable in env interpolation (resolved to empty string)"
                );
            }
            String::new()
        })
        .into_owned()
}

/// Apply the env chain. Call before spawning threads.
pub fn load(cli_overrides: &HashMap<String, String>) {
    if std::env::var(LOAD_DOTENV_KEY).as_deref() == Ok("0") {
        apply_cli_overrides(cli_overrides);
        return;
    }
    let Some(root) = find_project_root() else {
        apply_cli_overrides(cli_overrides);
        return;
    };

    let env_name = cli_overrides
        .get(BOOTSTRAP_ENV_KEY)
        .cloned()
        .or_else(|| std::env::var(BOOTSTRAP_ENV_KEY).ok())
        .unwrap_or_else(|| "dev".to_string());
    let snapshot: HashMap<String, String> = std::env::vars().collect();

    let env_file = cli_overrides
        .get(ENV_FILE_KEY)
        .cloned()
        .or_else(|| std::env::var(ENV_FILE_KEY).ok());
    let files: Vec<PathBuf> = match env_file {
        Some(value) => vec![resolve_env_file(&root, &value)],
        None => vec![
            root.join(".env"),
            root.join(format!(".env.{env_name}")),
            root.join(".env.local"),
        ],
    };

    let mut lookup = snapshot.clone();
    let mut loaded_any = false;
    for path in &files {
        if !path.exists() {
            continue;
        }
        loaded_any = true;
        match parse_env_file(path, &lookup) {
            Ok(entries) => {
                for (key, value) in entries {
                    // Materialize per file so the next file's native dotenvy
                    // substitution can resolve cross-file `${VAR}` references.
                    // §1.2 step 4: files never override the OS env snapshot.
                    if !snapshot.contains_key(&key) {
                        env_set(&key, &value);
                        tracing::debug!(key = %key, source = %path.display(), "Env loaded: {}=*** (masked)", key);
                    }
                    lookup.insert(key.clone(), value.clone());
                }
            }
            Err(error) => tracing::warn!(file = %path.display(), error = %error, "Failed to parse env file"),
        }
    }

    if loaded_any {
        tracing::debug!(files = ?files, "Env chain loaded");
    }
    apply_cli_overrides(cli_overrides);
}

/// Process-env writes are confined to the startup phase before any thread exists.
/// `Cargo.toml` sets `unsafe_code = "deny"`; this module narrows the allowance to
/// this single documented wrapper.
#[allow(unsafe_code)]
fn env_set(key: &str, value: &str) {
    // SAFETY: caller guarantees single-threaded startup (see module docs).
    unsafe { std::env::set_var(key, value) };
}

#[cfg(test)]
#[allow(unsafe_code)]
fn env_remove(key: &str) {
    // SAFETY: caller guarantees single-threaded startup (see module docs).
    unsafe { std::env::remove_var(key) };
}

fn apply_cli_overrides(cli_overrides: &HashMap<String, String>) {
    for key in cli_overrides.keys() {
        tracing::info!(key = %key, "CLI override: {}=***", key);
    }
    for (key, value) in cli_overrides {
        env_set(key, value);
    }
}

fn resolve_env_file(root: &Path, value: &str) -> PathBuf {
    let candidate = PathBuf::from(value);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

/// Parse one env file: `${VAR:-default}` is resolved against the chain lookup first
/// (dotenvy does not support the default form); plain `${VAR}` stays native so
/// same-file references keep working, and unresolved ones are reported.
fn parse_env_file(path: &Path, lookup: &HashMap<String, String>) -> Result<Vec<(String, String)>, String> {
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let with_defaults = DEFAULT_FORM
        .replace_all(&text, |caps: &regex::Captures<'_>| {
            let name = &caps[1];
            lookup
                .get(name)
                .cloned()
                .unwrap_or_else(|| caps[2].to_string())
        })
        .into_owned();

    let mut entries: Vec<(String, String)> = Vec::new();
    for item in dotenvy::from_read_iter(with_defaults.as_bytes()) {
        let (key, value) = item.map_err(|error| error.to_string())?;
        entries.push((key, value));
    }

    let mut defined = lookup.clone();
    for (key, value) in &entries {
        defined.insert(key.clone(), value.clone());
    }
    for caps in INTERPOLATION.captures_iter(&text) {
        let name = &caps[1];
        let has_default = caps.get(2).is_some();
        if !has_default && !defined.contains_key(name) {
            if CRITICAL_KEYS.contains(&name) {
                tracing::error!(key = name, file = %path.display(), "Undefined variable in env interpolation");
            } else {
                tracing::warn!(key = name, file = %path.display(), "Undefined variable in env interpolation");
            }
        }
    }
    Ok(entries)
}

fn find_project_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let mut dir = Some(cwd.as_path());
    for _ in 0..MAX_DEPTH {
        let current = dir?;
        if ROOT_MARKERS.iter().any(|marker| current.join(marker).exists()) {
            return Some(current.to_path_buf());
        }
        if current.join(".git").exists() {
            return None;
        }
        dir = current.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    static PROCESS_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        saved: HashMap<String, String>,
    }

    impl EnvGuard {
        fn capture(keys: &[&str]) -> Self {
            let mut saved = HashMap::new();
            for key in keys {
                if let Ok(value) = std::env::var(key) {
                    saved.insert((*key).to_string(), value);
                }
            }
            Self { saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for key in [
                "XIHE_ENV",
                "XIHE_LOAD_DOTENV",
                "XIHE_ENV_FILE",
                "XIHE_TEST_ALPHA",
                "XIHE_TEST_BETA",
                "XIHE_TEST_GAMMA",
                "XIHE_TEST_CHAIN",
                "XIHE_TEST_CRITICAL",
                "XIHE_TEST_DEFAULTED",
            ] {
                env_remove(key);
            }
            for (key, value) in &self.saved {
                env_set(key, value);
            }
        }
    }

    #[test]
    fn parse_cli_overrides_variants() {
        let args: Vec<String> = ["--set", "A=1", "--set=B=x=y", "ignored"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let overrides = parse_cli_overrides(&args).unwrap();
        assert_eq!(overrides.get("A").map(String::as_str), Some("1"));
        assert_eq!(overrides.get("B").map(String::as_str), Some("x=y"));
        assert_eq!(overrides.len(), 2);
        assert!(parse_cli_overrides(&["--set".to_string(), "NOEQUALS".to_string()]).is_err());
        assert!(parse_cli_overrides(&[]).unwrap().is_empty());
    }

    #[test]
    fn interpolate_forms() {
        let mut lookup = HashMap::new();
        lookup.insert("A".to_string(), "1".to_string());
        assert_eq!(interpolate("${A}", &lookup), "1");
        assert_eq!(interpolate("${MISSING:-fallback}", &lookup), "fallback");
        assert_eq!(interpolate("${MISSING}", &lookup), "");
        assert_eq!(interpolate("plain", &lookup), "plain");
    }

    #[test]
    fn load_chain_later_file_wins_and_os_env_snapshot_wins() {
        let _guard = PROCESS_LOCK.lock().unwrap();
        let _env = EnvGuard::capture(&["XIHE_ENV"]);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".env"), "XIHE_TEST_ALPHA=base\nXIHE_TEST_BETA=from_env\n").unwrap();
        fs::write(root.join(".env.dev"), "XIHE_TEST_ALPHA=dev\n").unwrap();
        fs::write(root.join(".env.local"), "XIHE_TEST_ALPHA=local\n").unwrap();

        let original = std::env::current_dir().unwrap();
        std::env::set_current_dir(root).unwrap();
        // snapshot: BETA already present → file must not override it
        env_set("XIHE_TEST_BETA", "from_os");
        env_set("XIHE_ENV", "dev");
        load(&HashMap::new());
        std::env::set_current_dir(original).unwrap();

        assert_eq!(std::env::var("XIHE_TEST_ALPHA").unwrap(), "local");
        assert_eq!(std::env::var("XIHE_TEST_BETA").unwrap(), "from_os");
    }

    #[test]
    fn load_interpolation_and_default_form_across_files() {
        let _guard = PROCESS_LOCK.lock().unwrap();
        let _env = EnvGuard::capture(&["XIHE_ENV"]);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".env"), "XIHE_TEST_GAMMA=127.0.0.1\n").unwrap();
        fs::write(
            root.join(".env.dev"),
            "XIHE_TEST_CHAIN=http://${XIHE_TEST_GAMMA}:12631\nXIHE_TEST_DEFAULTED=${XIHE_TEST_CRITICAL:-fallback}\n",
        )
        .unwrap();

        let original = std::env::current_dir().unwrap();
        std::env::set_current_dir(root).unwrap();
        env_set("XIHE_ENV", "dev");
        load(&HashMap::new());
        std::env::set_current_dir(original).unwrap();

        assert_eq!(
            std::env::var("XIHE_TEST_CHAIN").unwrap(),
            "http://127.0.0.1:12631"
        );
        assert_eq!(std::env::var("XIHE_TEST_DEFAULTED").unwrap(), "fallback");
    }

    #[test]
    fn load_cli_overrides_and_env_file_selection() {
        let _guard = PROCESS_LOCK.lock().unwrap();
        let _env = EnvGuard::capture(&["XIHE_ENV", "XIHE_ENV_FILE"]);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".env.test"), "XIHE_TEST_ALPHA=test\n").unwrap();
        fs::write(root.join("custom.env"), "XIHE_TEST_ALPHA=custom\n").unwrap();

        let original = std::env::current_dir().unwrap();
        std::env::set_current_dir(root).unwrap();
        let mut overrides = HashMap::new();
        overrides.insert("XIHE_ENV".to_string(), "test".to_string());
        overrides.insert("XIHE_TEST_ALPHA".to_string(), "cli".to_string());
        load(&overrides);
        assert_eq!(std::env::var("XIHE_TEST_ALPHA").unwrap(), "cli");

        overrides.remove("XIHE_TEST_ALPHA");
        overrides.insert("XIHE_ENV_FILE".to_string(), "custom.env".to_string());
        env_remove("XIHE_TEST_ALPHA");
        load(&overrides);
        std::env::set_current_dir(original).unwrap();
        assert_eq!(std::env::var("XIHE_TEST_ALPHA").unwrap(), "custom");
    }

    #[test]
    fn find_project_root_finds_env_dev() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".env.dev"), "TEST=1").unwrap();
        let result = in_dir(dir.path(), find_project_root);
        assert_eq!(result, Some(dir.path().to_path_buf()));
    }

    #[test]
    fn find_project_root_stops_at_git_boundary() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".git"), "").unwrap();
        let sub = dir.path().join("sub").join("deep");
        fs::create_dir_all(&sub).unwrap();
        let result = in_dir(&sub, find_project_root);
        assert_eq!(result, None);
    }

    #[test]
    fn find_project_root_returns_none_when_not_found() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".git"), "").unwrap();
        let result = in_dir(dir.path(), find_project_root);
        assert_eq!(result, None);
    }

    fn in_dir<T>(d: &std::path::Path, f: fn() -> T) -> T {
        let _guard = PROCESS_LOCK.lock().unwrap();
        let orig = std::env::current_dir().unwrap();
        std::env::set_current_dir(d).unwrap();
        let r = f();
        std::env::set_current_dir(orig).unwrap();
        r
    }
}
