//! PLAN-0307 T3.4 (decisions #7/#25/#32): distributed fail-fast for dangerous factory defaults.
//!
//! Runs after the config chain is loaded and validates the effective values. With an explicit
//! `XIHE_ENV=prod` any insecure default refuses startup and lists the offending keys plus the
//! fix; in dev/test (or unset, defaulting to dev) the same findings are only WARNed, and the
//! release gate must force an explicit `prod`. No per-module prod profile.
//!
//! The key list mirrors `spec/config-env-target.md` §6 and is duplicated per module by design
//! (no shared runtime dependency); keep the three implementations in sync.

use std::collections::HashSet;
use std::sync::LazyLock;

const PROD_ENV_NAME: &str = "prod";
const DEV_TOKEN: &str = "dev-token-not-secure";

static INSECURE_JWT_SECRETS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    HashSet::from([
        "xihe-cp-jwt-secret-key-change-in-production",
        "dev-jwt-secret-key-do-not-use-in-production-please-change",
    ])
});

/// Return human-readable violations of the dangerous-defaults contract.
pub fn collect_violations(lookup: &dyn Fn(&str) -> Option<String>) -> Vec<String> {
    let mut violations = Vec::new();

    if let Some(secret) = lookup("XIHE_CP_JWT_SECRET")
        && INSECURE_JWT_SECRETS.contains(secret.as_str())
    {
        violations.push(
            "XIHE_CP_JWT_SECRET: factory/placeholder secret is in use \
             (generate a random secret, e.g. `openssl rand -base64 48`)"
                .to_string(),
        );
    }
    if lookup("XIHE_CP_API_TOKEN").as_deref() == Some(DEV_TOKEN) {
        violations.push(
            "XIHE_CP_API_TOKEN: dev token `dev-token-not-secure` is in use (set a strong service token)"
                .to_string(),
        );
    }
    if lookup("XIHE_AGENT_API_TOKEN").as_deref() == Some(DEV_TOKEN) {
        violations.push(
            "XIHE_AGENT_API_TOKEN: dev token `dev-token-not-secure` is in use (set a strong service token)"
                .to_string(),
        );
    }
    if lookup("XIHE_CP_OAUTH_ALLOW_DEV_KEY").as_deref() == Some("true") {
        violations.push(
            "XIHE_CP_OAUTH_ALLOW_DEV_KEY: must be `false` in prod \
             (dev fallback encryption key would be accepted)"
                .to_string(),
        );
    }
    if lookup("XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY").as_deref() == Some("true") {
        violations.push(
            "XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY: must be `false` in prod \
             (dev fallback encryption key would be accepted)"
                .to_string(),
        );
    }
    if is_blank(lookup("XIHE_CP_OAUTH_ENCRYPTION_KEY")) {
        violations.push(
            "XIHE_CP_OAUTH_ENCRYPTION_KEY: required in prod (provide a base64 key)".to_string(),
        );
    }
    if is_blank(lookup("XIHE_CP_PROVIDER_CREDENTIALS_KEY")) {
        violations.push(
            "XIHE_CP_PROVIDER_CREDENTIALS_KEY: required in prod (provide a base64 key)".to_string(),
        );
    }
    violations
}

/// Validate the effective configuration; returns an error when prod is explicitly requested.
pub fn enforce() -> anyhow::Result<()> {
    let lookup = |key: &str| std::env::var(key).ok();
    let env_name = std::env::var("XIHE_ENV").unwrap_or_else(|_| "dev".to_string());
    let violations = collect_violations(&lookup);
    if violations.is_empty() {
        return Ok(());
    }
    let body = violations.join("\n - ");
    if env_name == PROD_ENV_NAME {
        tracing::error!(
            "Refusing to start: insecure default configuration in prod mode:\n - {}\n\
             Fix the keys above (set real secrets / disable dev keys), then restart.",
            body
        );
        anyhow::bail!("Insecure default configuration rejected in prod mode");
    }
    tracing::warn!(
        "Insecure default configuration detected ({} mode: WARN only; a prod start would \
         refuse):\n - {}\nFix before deploying to prod.",
        env_name,
        body
    );
    Ok(())
}

fn is_blank(value: Option<String>) -> bool {
    value.map(|item| item.trim().is_empty()).unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    #[test]
    fn collect_violations_flags_all_dangerous_defaults() {
        let lookup = lookup_of(&[
            ("XIHE_CP_JWT_SECRET", "xihe-cp-jwt-secret-key-change-in-production"),
            ("XIHE_CP_API_TOKEN", "dev-token-not-secure"),
            ("XIHE_AGENT_API_TOKEN", "dev-token-not-secure"),
            ("XIHE_CP_OAUTH_ALLOW_DEV_KEY", "true"),
            ("XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY", "true"),
        ]);
        // 5 explicit insecure values + 2 empty-required encryption keys
        assert_eq!(collect_violations(&lookup).len(), 7);
    }

    #[test]
    fn collect_violations_accepts_secure_values() {
        let lookup = lookup_of(&[
            ("XIHE_CP_JWT_SECRET", "a-real-random-secret"),
            ("XIHE_CP_API_TOKEN", "strong-service-token"),
            ("XIHE_AGENT_API_TOKEN", "strong-service-token"),
            ("XIHE_CP_OAUTH_ALLOW_DEV_KEY", "false"),
            ("XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY", "false"),
            ("XIHE_CP_OAUTH_ENCRYPTION_KEY", "base64-key"),
            ("XIHE_CP_PROVIDER_CREDENTIALS_KEY", "base64-key"),
        ]);
        assert!(collect_violations(&lookup).is_empty());
    }
}
