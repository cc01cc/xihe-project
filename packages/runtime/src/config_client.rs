use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use reqwest::Client;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

static CONFIG_CLIENT: OnceLock<Mutex<ConfigClient>> = OnceLock::new();
const CP_URL_ENV: &str = "XIHE_CP_URL";
const CP_API_TOKEN_ENV: &str = "XIHE_CP_API_TOKEN";

const ADMIN_DOMAINS: &[&str] = &[
    "llm-provider",
    "logging",
    "embedding",
    "workspace-config",
    "user-preference",
];
const SYSTEM_DOMAINS: &[&str] = &[
    "llm-provider",
    "logging",
    "embedding",
    "workspace-config",
    "user-preference",
    "infrastructure",
];

pub struct ConfigClient {
    cp_url: String,
    api_token: String,
    client: Client,
    admin_cache: HashMap<String, HashMap<String, String>>,
    system_cache: HashMap<String, HashMap<String, String>>,
    last_fetch: Option<Instant>,
}

impl ConfigClient {
    pub fn new(cp_url: &str, api_token: &str) -> Self {
        Self {
            cp_url: cp_url.to_string(),
            api_token: api_token.to_string(),
            client: Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .expect("Failed to build HTTP client"),
            admin_cache: HashMap::new(),
            system_cache: HashMap::new(),
            last_fetch: None,
        }
    }

    pub async fn sync(&mut self) -> Result<(), reqwest::Error> {
        let headers = Self::auth_headers(&self.api_token);

        for domain in ADMIN_DOMAINS {
            let url = format!("{}/internal/config/admin/{}", self.cp_url, domain);
            match self.client.get(&url).headers(headers.clone()).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(map) = resp.json::<HashMap<String, String>>().await {
                        self.admin_cache.insert(domain.to_string(), map);
                    }
                }
                Ok(resp) => debug!("ConfigClient: admin/{} returned {}", domain, resp.status()),
                Err(e) => debug!("ConfigClient: admin/{} failed: {}", domain, e),
            }
        }

        for domain in SYSTEM_DOMAINS {
            let url = format!("{}/internal/config/system/{}", self.cp_url, domain);
            match self.client.get(&url).headers(headers.clone()).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(map) = resp.json::<HashMap<String, String>>().await {
                        self.system_cache.insert(domain.to_string(), map);
                    }
                }
                Ok(resp) => debug!("ConfigClient: system/{} returned {}", domain, resp.status()),
                Err(e) => debug!("ConfigClient: system/{} failed: {}", domain, e),
            }
        }

        self.last_fetch = Some(Instant::now());
        info!(
            "ConfigClient: synced {} admin domains, {} system domains",
            self.admin_cache.len(),
            self.system_cache.len()
        );
        Ok(())
    }

    pub async fn sync_with_retry(&mut self, max_retries: u32) {
        for attempt in 0..max_retries {
            match self.sync().await {
                Ok(()) => return,
                Err(e) => {
                    warn!("ConfigClient: sync {}/{} failed: {}", attempt + 1, max_retries, e);
                    if attempt < max_retries - 1 {
                        tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
                    }
                }
            }
        }
        error!("ConfigClient: failed after {} retries", max_retries);
    }

    pub fn get(&self, domain: &str, key: &str) -> Option<&str> {
        if let Some(admin) = self.admin_cache.get(domain)
            && let Some(val) = admin.get(key)
        {
            return Some(val.as_str());
        }
        if let Some(system) = self.system_cache.get(domain)
            && let Some(val) = system.get(key)
        {
            return Some(val.as_str());
        }
        None
    }

    fn auth_headers(api_token: &str) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Ok(v) = reqwest::header::HeaderValue::from_str(api_token) {
            headers.insert("X-Api-Token", v);
        }
        headers
    }
}

pub async fn init_global_config_client() {
    let cp_url = std::env::var(CP_URL_ENV).unwrap_or_else(|_| "http://localhost:12631".into());
    let api_token = std::env::var(CP_API_TOKEN_ENV).unwrap_or_else(|_| "dev-token-not-secure".into());
    let mut client = ConfigClient::new(&cp_url, &api_token);
    client.sync_with_retry(3).await;
    CONFIG_CLIENT
        .set(Mutex::new(client))
        .unwrap_or_else(|_| warn!("ConfigClient already initialized"));
}

pub async fn get_cp(domain: &str, key: &str) -> Option<String> {
    if let Some(mutex) = CONFIG_CLIENT.get() {
        let client = mutex.lock().await;
        client.get(domain, key).map(|s| s.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_client_initial_state() {
        let client = ConfigClient::new("http://cp:8080", "test-token");
        assert_eq!(client.cp_url, "http://cp:8080");
        assert_eq!(client.api_token, "test-token");
        assert!(client.admin_cache.is_empty());
        assert!(client.system_cache.is_empty());
        assert!(client.last_fetch.is_none());
    }

    #[test]
    fn test_get_admin_precedence() {
        let mut client = ConfigClient::new("http://cp:8080", "test-token");
        let mut admin = HashMap::new();
        admin.insert("logLevel".to_string(), "debug".to_string());
        client.admin_cache.insert("logging".to_string(), admin);

        let mut system = HashMap::new();
        system.insert("logLevel".to_string(), "info".to_string());
        client.system_cache.insert("logging".to_string(), system);

        assert_eq!(client.get("logging", "logLevel"), Some("debug"));
    }

    #[test]
    fn test_get_fallback_to_system() {
        let mut client = ConfigClient::new("http://cp:8080", "test-token");
        let mut system = HashMap::new();
        system.insert("logLevel".to_string(), "info".to_string());
        client.system_cache.insert("logging".to_string(), system);

        assert_eq!(client.get("logging", "logLevel"), Some("info"));
    }

    #[test]
    fn test_get_missing_domain_returns_none() {
        let client = ConfigClient::new("http://cp:8080", "test-token");
        assert_eq!(client.get("nonexistent", "key"), None);
    }

    #[test]
    fn test_get_missing_key_returns_none() {
        let mut client = ConfigClient::new("http://cp:8080", "test-token");
        let mut admin = HashMap::new();
        admin.insert("logLevel".to_string(), "info".to_string());
        client.admin_cache.insert("logging".to_string(), admin);

        assert_eq!(client.get("logging", "missingKey"), None);
    }

    #[test]
    fn test_get_empty_string_is_valid_value() {
        let mut client = ConfigClient::new("http://cp:8080", "test-token");
        let mut admin = HashMap::new();
        admin.insert("key".to_string(), "".to_string());
        client.admin_cache.insert("test".to_string(), admin);

        assert_eq!(client.get("test", "key"), Some(""));
    }

    #[test]
    fn test_sync_populates_cache() {
        let mut client = ConfigClient::new("http://cp:8080", "test-token");
        let mut admin = HashMap::new();
        admin.insert("openaiApiKey".to_string(), "sk-test".to_string());
        client.admin_cache.insert("llm-provider".to_string(), admin);

        let mut system = HashMap::new();
        system.insert("dbUrl".to_string(), "jdbc:test".to_string());
        client.system_cache.insert("infrastructure".to_string(), system);

        client.last_fetch = Some(Instant::now());

        assert!(client.last_fetch.is_some());
        assert_eq!(
            client.get("llm-provider", "openaiApiKey"),
            Some("sk-test")
        );
        assert_eq!(client.get("infrastructure", "dbUrl"), Some("jdbc:test"));
    }

    #[test]
    fn test_auth_headers() {
        let headers = ConfigClient::auth_headers("test-token");
        assert_eq!(
            headers.get("X-Api-Token").and_then(|v| v.to_str().ok()),
            Some("test-token")
        );
    }
}
