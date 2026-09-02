/// M3-4.2/4.3 — grill Q7 A + Q13 A + Q18 A: only Docker+image vs blocked
#[derive(Debug, PartialEq)]
pub enum Observed {
    Ready,
    Blocked(String),
}

pub fn check(required_ok: bool, reason: &str) -> Observed {
    if required_ok {
        Observed::Ready
    } else {
        Observed::Blocked(reason.to_string())
    }
}

/// Q18 A minimal: only Docker available + xihe/workspace image exists
pub async fn check_required() -> Observed {
    let docker = match bollard::Docker::connect_with_local_defaults() {
        Ok(d) => d,
        Err(e) => return Observed::Blocked(format!("Docker unavailable: {}", e)),
    };
    match docker.inspect_image("xihe/workspace").await {
        Ok(_) => Observed::Ready,
        Err(e) => Observed::Blocked(format!("image xihe/workspace not found: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ready_when_required_ok() {
        assert_eq!(check(true, ""), Observed::Ready);
    }

    #[test]
    fn test_blocked_when_required_missing() {
        assert_eq!(
            check(false, "missing docker"),
            Observed::Blocked("missing docker".to_string())
        );
    }

    #[tokio::test]
    async fn test_check_required_with_docker() {
        let result = check_required().await;
        // On dev machine with Docker and xihe/workspace, should be Ready
        match result {
            Observed::Ready => {}
            Observed::Blocked(msg) => {
                // If Docker unavailable, skip (don't fail)
                if msg.contains("Docker unavailable") {
                    println!("Docker unavailable, skipping: {}", msg);
                } else {
                    panic!("expected Ready but got Blocked: {}", msg);
                }
            }
        }
    }
}
