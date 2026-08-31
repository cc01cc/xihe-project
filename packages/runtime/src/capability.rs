/// M3-4.2/4.3 — grill Q7 A + Q13 A: only blocked vs ready (degraded/stale deferred)
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
}
