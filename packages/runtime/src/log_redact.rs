use std::io::{self, Write};
use std::sync::OnceLock;

use regex::Regex;
use tracing_subscriber::fmt::MakeWriter;

const REDACTED: &str = "***redacted***";

fn value_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?i)Bearer\s+[A-Za-z0-9._~+/=-]+",
            r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
            r#"(?i)("(?:access_?token|refresh_?token|api_?key|service_?token|client_?secret|token|secret|password|authorization|cookie|pkce|verifier)"\s*:\s*")[^"]*"#,
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("redaction regex must compile"))
        .collect()
    })
}

pub fn redact_text(text: &str) -> String {
    let mut result = text.to_string();
    for pattern in value_patterns() {
        result = pattern
            .replace_all(&result, |caps: &regex::Captures<'_>| {
                if let Some(prefix) = caps.get(1) {
                    format!("{}{}\"", prefix.as_str(), REDACTED)
                } else {
                    REDACTED.to_string()
                }
            })
            .into_owned();
    }
    result
}

pub struct RedactingWriter<W> {
    inner: W,
}

impl<W> RedactingWriter<W> {
    pub fn new(inner: W) -> Self {
        Self { inner }
    }
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        let redacted = redact_text(&text);
        self.inner.write_all(redacted.as_bytes())?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

pub struct RedactingMakeWriter<F> {
    make: F,
}

impl<F> RedactingMakeWriter<F> {
    pub fn new(make: F) -> Self {
        Self { make }
    }
}

impl<F, W> MakeWriter<'_> for RedactingMakeWriter<F>
where
    F: for<'a> MakeWriter<'a, Writer = W>,
    W: Write,
{
    type Writer = RedactingWriter<W>;

    fn make_writer(&self) -> Self::Writer {
        RedactingWriter::new(self.make.make_writer())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_and_jwt() {
        let out = redact_text("auth failed with Bearer sk-live-abcdef123456");
        assert!(!out.contains("sk-live"));
        assert!(out.contains(REDACTED));

        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dGVzdHNpZw";
        let out = redact_text(&format!("got {jwt}"));
        assert!(!out.contains("eyJhbGciOiJIUzI1NiJ9"));
    }

    #[test]
    fn redacts_json_sensitive_fields_keeps_others() {
        let line = r#"{"msg":"ok","refresh_token":"rt-secret-123","note":"visible"}"#;
        let out = redact_text(line);
        assert!(!out.contains("rt-secret-123"));
        assert!(out.contains("visible"));
        assert!(out.contains(&format!("\"refresh_token\":\"{}\"", REDACTED)));
    }

    #[test]
    fn writer_redacts_stream() {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut writer = RedactingWriter::new(&mut buf);
            writer
                .write_all(b"token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dGVzdHNpZw done")
                .expect("write");
        }
        let out = String::from_utf8(buf).expect("utf8");
        assert!(!out.contains("eyJhbGciOiJIUzI1NiJ9"));
        assert!(out.contains("done"));
    }
}
