//! 构建期身份埋点（BL-324 runtime 半边 / task-238，2026-11-13）。
//!
//! **为什么必须在这里埋**：`XIHE_BUILD_COMMIT` 是「谁启动谁负责」的运行期 env —— 全仓只有读取点、
//! 没有生产注入点（BL-496/535 的实测），所以「这栈跑的是不是当前代码」在 runtime 侧只能靠进程启动时间间接推。
//! 构建期把 sha 写进产物后，**读到的值来自这段代码本身**，与谁启动、注没注 env 无关。
//!
//! 形态与 CP 的 `<sha12>[-dirty]` 一致：干净树 `<sha12>`，工作树里有未提交改动 `<sha12>-dirty`。
//!
//! 三条不做的事：
//! 1. **不硬编码**任何 sha（值只来自 `git`）；git 不可用（tarball / docker build）⇒ `unknown`，不写空串。
//! 2. **dirty 只判本 crate 目录内**的改动（`git status --porcelain -- .`）：别的包/别的 lane 的脏
//!    不该把 runtime 的 commit 标脏（那是另一个问题，混进来会让这个标志永远为真 = 不可用）。
//! 3. **未跟踪但未被 ignore 的文件算脏**（新增源文件确实改变构建结果），**被 `.gitignore` 覆盖的不算**
//!    （`logs/`、`target/`、`.xihe-*/`、`*.log` 就在 crate 目录里，判它们等于恒脏）。
//!
//! 已知边界（诚实登记，不假装覆盖）：build script 只在被 watch 的路径变化时重跑。这里 watch
//! `src/`、`tests/`、`Cargo.toml`、`Cargo.lock`、`build.rs` 与 gitdir 的 HEAD/分支 ref/index，
//! 因此**在 `src/` 或 `tests/` 之外的改动（如 README、seccomp-profile.json）不会刷新 dirty 位** ——
//! 要刷新就改一次源码或 `cargo clean -p xihe-runtime`。sha 位不受此影响（它跟着 commit 走）。
use std::path::{Path, PathBuf};
use std::process::Command;

const UNKNOWN: &str = "unknown";
const SHORT_COMMIT_LEN: usize = 12;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=tests");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=Cargo.lock");
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
    let manifest_dir = Path::new(&manifest_dir);
    for path in watched_git_paths(manifest_dir) {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let value = compute(manifest_dir).unwrap_or_else(|| {
        println!(
            "cargo:warning=xihe-runtime: 构建身份不可用（非 git 检出或 git 调用失败）⇒ commit={UNKNOWN}"
        );
        UNKNOWN.to_string()
    });
    println!("cargo:rustc-env=XH_RUNTIME_BUILD_COMMIT={value}");
}

/// `git rev-parse --short=12 HEAD` ⇒ `<sha12>[-dirty]`；任一环节读不到就返回 `None`（由调用方写 `unknown`）。
fn compute(manifest_dir: &Path) -> Option<String> {
    let sha = git(
        manifest_dir,
        &["rev-parse", &format!("--short={SHORT_COMMIT_LEN}"), "HEAD"],
    )?;
    if !(7..=40).contains(&sha.len()) || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    // 判脏失败时按**脏**处理（fail-closed）：报成干净 sha 会比报成脏更难查。
    let dirty = git(manifest_dir, &["status", "--porcelain", "--", "."])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(true);
    Some(if dirty { format!("{sha}-dirty") } else { sha })
}

/// 会让「埋进去的值」过期的 git 路径。linked worktree 下 `.git` 是文件，所以必须用
/// `rev-parse --absolute-git-dir` 取真实 gitdir，不能拼 `../../.git`。
fn watched_git_paths(manifest_dir: &Path) -> Vec<PathBuf> {
    let Some(gitdir) = git(manifest_dir, &["rev-parse", "--absolute-git-dir"]) else {
        return Vec::new();
    };
    let gitdir = PathBuf::from(gitdir);
    let mut paths = vec![
        gitdir.join("HEAD"),
        gitdir.join("index"),
        gitdir.join("packed-refs"),
    ];
    // 分支推进 = `refs/heads/<branch>` 变化；detached HEAD 时 HEAD 文件本身就是 sha，已在上表。
    if let Some(branch) = git(manifest_dir, &["symbolic-ref", "-q", "--short", "HEAD"]) {
        paths.push(gitdir.join("refs").join("heads").join(branch));
    }
    paths
}

fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8(out.stdout).ok()?.trim().to_string())
}
