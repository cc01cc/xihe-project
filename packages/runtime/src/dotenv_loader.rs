use std::path::PathBuf;

const MAX_DEPTH: u32 = 5;

pub fn load() {
    if std::env::var("XIHE_LOAD_DOTENV").as_deref() == Ok("0") {
        return;
    }
    let Some(root) = find_project_root() else {
        return;
    };
    let env_path = root.join(".env");
    if env_path.exists() {
        let _ = dotenvy::from_path(&env_path);
    }
    let dev_path = root.join(".env.dev");
    if dev_path.exists() {
        let _ = dotenvy::from_path(&dev_path);
    }
}

fn find_project_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let mut dir = Some(cwd.as_path());
    for _ in 0..MAX_DEPTH {
        let current = dir?;
        if current.join(".env.dev").exists() {
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

    static CURRENT_DIR_LOCK: Mutex<()> = Mutex::new(());

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
        let _guard = CURRENT_DIR_LOCK.lock().unwrap();
        let orig = std::env::current_dir().unwrap();
        std::env::set_current_dir(d).unwrap();
        let r = f();
        std::env::set_current_dir(orig).unwrap();
        r
    }
}
