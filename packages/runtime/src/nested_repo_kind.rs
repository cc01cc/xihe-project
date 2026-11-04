//! PLAN-0641 T2.2 — 嵌套仓识别判据（五型分类）。
//!
//! 膨胀门（Lead 要求写进文件头）：**本文件只提供识别判据，无新概念**——不引入注册表、
//! 不新增表、不新增一级领域词（「声明为根」仍是 0639 既有「根」概念的一次 CRUD）。
//! 候选来源由调用方决定：capture 的 gitlink 清单（§6.1 事实源，零额外扫描）或
//! 按需端点的冷探测；分类本身是路径级判定，不触发任何写入。
//!
//! 判据出处：design §6.1 五型表（2026-11-03 冻结，D41-6 方向下的发现分类）。

use serde::Serialize;
use std::path::Path;

/// 五型分类；wire 值 = `NestedRepoItem.type`（contract-draft F4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NestedRepoKind {
    /// gitlink（mode 160000）且 `.git` 为目录：普通嵌套仓。
    Nested,
    /// `.git` 是文件、`gitdir:` 指向父仓 `.git/worktrees/…`：linked worktree。
    /// 声明后与父仓 HEAD 解耦，需用户知情（§6.1）。
    Gitdir,
    /// `.git` 是文件、`gitdir:` 指向 `.git/modules/…`：用户已有的嵌套声明，
    /// 只标记不提示声明（B6/D41-22）。
    Submodule,
    /// 无 `.git`，但 `HEAD` + `objects/` + `refs/` 三件齐：bare 启发式
    /// （gitlink 清单不出现，冷探测侧来源；v1 只警告不支持声明）。
    Bare,
    /// 目录项为 symlink：仅分类展示，越界仍走既有 `SymlinkEscape` 拒绝（§6.1）。
    Symlink,
}

impl NestedRepoKind {
    /// wire 枚举值（与 `#[serde(rename_all = "lowercase")]` 一致，供非 serde 场景使用）。
    pub fn as_wire(&self) -> &'static str {
        match self {
            NestedRepoKind::Nested => "nested",
            NestedRepoKind::Gitdir => "gitdir",
            NestedRepoKind::Submodule => "submodule",
            NestedRepoKind::Bare => "bare",
            NestedRepoKind::Symlink => "symlink",
        }
    }
}

/// 分类 `work_tree`（工作树根）下的 `rel_path`（workspace 相对 POSIX 路径）。
///
/// 读取失败按「已检测为 gitlink 但细节不可读」处理 ⇒ 归 `Nested`：候选来自
/// gitlink 清单时它必是一个嵌套仓，展示面不应因一次 IO 抖动而消失。
pub fn classify(work_tree: &Path, rel_path: &str) -> NestedRepoKind {
    let absolute = work_tree.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    classify_absolute(&absolute)
}

fn classify_absolute(absolute: &Path) -> NestedRepoKind {
    let meta = match std::fs::symlink_metadata(absolute) {
        Ok(meta) => meta,
        Err(_) => return NestedRepoKind::Nested,
    };
    if meta.file_type().is_symlink() {
        return NestedRepoKind::Symlink;
    }

    let git_path = absolute.join(".git");
    match std::fs::symlink_metadata(&git_path) {
        Ok(git_meta) if git_meta.file_type().is_dir() => return NestedRepoKind::Nested,
        Ok(git_meta) if git_meta.file_type().is_file() => {
            let content = std::fs::read_to_string(&git_path).unwrap_or_default();
            let target = content
                .trim()
                .strip_prefix("gitdir:")
                .unwrap_or(content.trim());
            let normalized = target.replace('\\', "/");
            let segments: Vec<&str> = normalized.split('/').collect();
            if segments.contains(&"modules") {
                return NestedRepoKind::Submodule;
            }
            // worktrees/… ⇒ linked worktree；其余 gitdir 指针按 worktree 语义归类。
            return NestedRepoKind::Gitdir;
        }
        _ => {}
    }

    if absolute.join("HEAD").is_file()
        && absolute.join("objects").is_dir()
        && absolute.join("refs").is_dir()
    {
        return NestedRepoKind::Bare;
    }
    NestedRepoKind::Nested
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// T2.2 判据：5 类各 1 条夹具测试。
    #[test]
    fn classifies_plain_nested_repo_by_git_dir() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join("vendor").join("lib");
        fs::create_dir_all(repo.join(".git")).expect("mkdir .git dir");
        assert_eq!(classify(temp.path(), "vendor/lib"), NestedRepoKind::Nested);
    }

    #[test]
    fn classifies_gitdir_pointer_as_worktree() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join("wt");
        fs::create_dir_all(&repo).expect("mkdir");
        fs::write(repo.join(".git"), "gitdir: /parent/.git/worktrees/wt\n").expect("git file");
        assert_eq!(classify(temp.path(), "wt"), NestedRepoKind::Gitdir);
    }

    #[test]
    fn classifies_module_pointer_as_submodule() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join("vendor").join("dep");
        fs::create_dir_all(&repo).expect("mkdir");
        fs::write(repo.join(".git"), "gitdir: ../../.git/modules/vendor/dep\n").expect("git file");
        assert_eq!(
            classify(temp.path(), "vendor/dep"),
            NestedRepoKind::Submodule
        );
    }

    #[test]
    fn classifies_bare_repo_by_head_objects_refs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bare = temp.path().join("mirror.git");
        fs::create_dir_all(bare.join("objects")).expect("mkdir objects");
        fs::create_dir_all(bare.join("refs")).expect("mkdir refs");
        fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").expect("HEAD");
        assert_eq!(classify(temp.path(), "mirror.git"), NestedRepoKind::Bare);
    }

    #[test]
    fn classifies_symlink_entry_as_symlink() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("real-repo");
        fs::create_dir_all(target.join(".git")).expect("mkdir target");
        let link = temp.path().join("linked");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        #[cfg(windows)]
        {
            if let Err(error) = std::os::windows::fs::symlink_dir(&target, &link) {
                // 无 symlink 权限的宿主：本机不支持创建夹具，记录后跳过断言（不伪装通过）。
                eprintln!("symlink fixture unavailable on this host: {error}");
                return;
            }
        }
        assert_eq!(classify(temp.path(), "linked"), NestedRepoKind::Symlink);
    }

    #[test]
    fn wire_values_match_contract_enum() {
        assert_eq!(NestedRepoKind::Nested.as_wire(), "nested");
        assert_eq!(NestedRepoKind::Gitdir.as_wire(), "gitdir");
        assert_eq!(NestedRepoKind::Submodule.as_wire(), "submodule");
        assert_eq!(NestedRepoKind::Bare.as_wire(), "bare");
        assert_eq!(NestedRepoKind::Symlink.as_wire(), "symlink");
        let json = serde_json::to_string(&NestedRepoKind::Submodule).expect("serialize");
        assert_eq!(json, "\"submodule\"");
    }
}
