use rmcp::schemars;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WebFetchRequest {
    pub url: String,
    pub format: Option<String>,
    pub timeout: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct WebFetchResult {
    pub content: String,
    pub url: String,
    pub truncated: bool,
}

pub async fn web_fetch(
    url: &str,
    format: Option<&str>,
    timeout: Option<u64>,
) -> Result<WebFetchResult, String> {
    let timeout_duration = std::time::Duration::from_secs(timeout.unwrap_or(30));
    let parsed_url = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
    let is_loopback = parsed_url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    let mut client_builder = reqwest::Client::builder()
        .timeout(timeout_duration)
        .user_agent("xihe-runtime/1.0");
    if is_loopback {
        client_builder = client_builder.no_proxy();
    }
    let client = client_builder
        .build()
        .map_err(|e| format!("HTTP client init: {e}"))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {} for {}", status.as_u16(), url));
    }

    let max_bytes: u64 = 5 * 1024 * 1024; // 5MB limit
    let mut truncated = response
        .content_length()
        .map(|len| len > max_bytes)
        .unwrap_or(false);

    let body = response
        .bytes()
        .await
        .map_err(|e| format!("Read body failed: {e}"))?;

    let content = match format {
        Some("text") => String::from_utf8_lossy(&body).to_string(),
        Some("html") => String::from_utf8_lossy(&body).to_string(),
        _ => {
            // Default: HTML → Markdown
            let html_str = String::from_utf8_lossy(&body);
            let document = scraper::Html::parse_document(&html_str);
            let markdown = html2md::parse_html(&document.html());
            if markdown.len() > body.len() && body.len() > 1000 {
                // html2md produced garbage (likely already plain text), use raw text
                String::from_utf8_lossy(&body).to_string()
            } else {
                markdown
            }
        }
    };

    let content = if content.len() > max_bytes as usize {
        truncated = true;
        content[..max_bytes as usize].to_string()
    } else {
        content
    };

    Ok(WebFetchResult {
        content,
        url: url.to_string(),
        truncated,
    })
}
