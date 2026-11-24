//! task-992: the single MXC executable resolver.
//!
//! Before this module every launch path read `XIHE_MXC_EXECUTABLE` on its own
//! (`execute_mxc`, `probe_mxc`, the job adapter), falling back to a bare `wxc-exec.exe`
//! that the OS resolved through PATH. A product-managed installation therefore
//! existed on disk but was never used. The order below is the contract the CP
//! installer and the execution-mode selector both promise:
//!
//! ```text
//! XIHE_MXC_EXECUTABLE (env, operator escape hatch, checksum bypassed)
//!   > <installDir>/override.json (instance owner override, checksum bypassed)
//!   > <installDir>/install.json (managed install, checksum enforced)
//!   > PATH wxc-exec.exe (system install)
//! ```

use std::fmt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Explicit operator override; highest priority and checksum-exempt by design.
pub const MXC_EXECUTABLE_ENV: &str = "XIHE_MXC_EXECUTABLE";
/// Product-owned install directory. Shared with CP so both processes agree.
pub const MXC_INSTALL_DIR_ENV: &str = "XIHE_WORKSPACE_MXC_INSTALL_DIR";
pub const WXC_EXEC_NAME: &str = "wxc-exec.exe";
pub const INSTALL_MANIFEST_NAME: &str = "install.json";
pub const INSTANCE_OVERRIDE_NAME: &str = "override.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MxcExecutableSource {
    /// `XIHE_MXC_EXECUTABLE` — operator escape hatch, checksum intentionally skipped.
    EnvOverride,
    /// `<installDir>/override.json` — instance-level path chosen by the instance owner.
    InstanceOverride,
    /// `<installDir>/install.json` — product-managed version, checksum enforced.
    ManagedManifest,
    /// `wxc-exec.exe` found on PATH — somebody else's install, not version controlled.
    Path,
}

impl MxcExecutableSource {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::EnvOverride => "env(override)",
            Self::InstanceOverride => "instance(override)",
            Self::ManagedManifest => "managed",
            Self::Path => "path",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedMxcExecutable {
    pub path: PathBuf,
    pub source: MxcExecutableSource,
    /// Only the managed manifest knows a version; everything else is "unknown".
    pub version: Option<String>,
    /// True only when a manifest checksum was verified successfully.
    pub checksum_verified: bool,
    /// The source that would have answered if no higher-priority source existed.
    /// Used by the CP snapshot so `env(override)` is visible next to `managed`.
    pub shadowed: Option<MxcExecutableSource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MxcResolveError {
    EnvOverrideMissing(PathBuf),
    OverrideInvalid(String),
    InstanceOverrideMissing(PathBuf),
    ManifestInvalid(String),
    ChecksumMismatch { expected: String, actual: String },
    NotFound,
}

impl MxcResolveError {
    /// Stable, user-readable code surfaced by the capability probe / job start.
    pub fn code(&self) -> &'static str {
        match self {
            Self::EnvOverrideMissing(_) => "MXC_EXECUTABLE_MISSING",
            Self::OverrideInvalid(_) => "MXC_OVERRIDE_INVALID",
            Self::InstanceOverrideMissing(_) => "MXC_INSTANCE_OVERRIDE_MISSING",
            Self::ManifestInvalid(_) => "MXC_MANIFEST_INVALID",
            Self::ChecksumMismatch { .. } => "MXC_CHECKSUM_MISMATCH",
            Self::NotFound => "MXC_NOT_INSTALLED",
        }
    }
}

impl fmt::Display for MxcResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EnvOverrideMissing(path) => write!(
                f,
                "{} points at {}, which is not a file",
                MXC_EXECUTABLE_ENV,
                path.display()
            ),
            Self::OverrideInvalid(detail) => write!(f, "instance override unreadable: {detail}"),
            Self::InstanceOverrideMissing(path) => {
                write!(
                    f,
                    "instance override points at {}, which is not a file",
                    path.display()
                )
            }
            Self::ManifestInvalid(detail) => write!(f, "managed manifest invalid: {detail}"),
            Self::ChecksumMismatch { expected, actual } => write!(
                f,
                "managed executable checksum mismatch (expected {expected}, got {actual})"
            ),
            Self::NotFound => write!(f, "no managed, overridden or PATH MXC installation found"),
        }
    }
}

impl std::error::Error for MxcResolveError {}

#[derive(Debug, Deserialize)]
struct InstallManifest {
    version: String,
    executable: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct InstanceOverride {
    executable: String,
}

/// Resolve the install directory from an env snapshot. Mirrors
/// `WorkspaceBackendPolicy.mxcInstallDir` on the CP side: product-owned only.
pub fn install_dir_from<F>(env: F) -> PathBuf
where
    F: Fn(&str) -> Option<String>,
{
    if let Some(raw) = env(MXC_INSTALL_DIR_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Some(local) = env("LOCALAPPDATA").filter(|value| !value.trim().is_empty()) {
        return Path::new(local.trim()).join("Xihe").join("mxc");
    }
    if let Some(home) = env("HOME").filter(|value| !value.trim().is_empty()) {
        return Path::new(home.trim()).join(".xihe").join("mxc");
    }
    PathBuf::from(".xihe").join("mxc")
}

/// Product entry point: resolve using the live process environment.
pub fn resolve_mxc_executable() -> Result<ResolvedMxcExecutable, MxcResolveError> {
    resolve_from(|key| std::env::var(key).ok())
}

/// Launch-path variant: when nothing is installed we keep the historical bare
/// `wxc-exec.exe` program so the OS/PATH decides and the spawn error stays as
/// actionable as before. Every *invalid* state (bad manifest, checksum mismatch,
/// dangling override) still fails closed — only `NotFound` degrades.
pub fn resolve_mxc_executable_or_path() -> Result<ResolvedMxcExecutable, MxcResolveError> {
    match resolve_mxc_executable() {
        Ok(resolved) => Ok(resolved),
        Err(MxcResolveError::NotFound) => Ok(ResolvedMxcExecutable {
            path: PathBuf::from(WXC_EXEC_NAME),
            source: MxcExecutableSource::Path,
            version: None,
            checksum_verified: false,
            shadowed: None,
        }),
        Err(error) => Err(error),
    }
}

/// Testable core: every decision is driven by an explicit env snapshot.
pub fn resolve_from<F>(env: F) -> Result<ResolvedMxcExecutable, MxcResolveError>
where
    F: Fn(&str) -> Option<String> + Copy,
{
    let install_dir = install_dir_from(env);
    let mut shadowed: Option<MxcExecutableSource> = None;

    if let Some(raw) = env(MXC_EXECUTABLE_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if !path.is_file() {
                // Fail closed: an operator typo must not silently fall back to a
                // managed build the operator was trying to bypass.
                return Err(MxcResolveError::EnvOverrideMissing(path));
            }
            return Ok(ResolvedMxcExecutable {
                path,
                source: MxcExecutableSource::EnvOverride,
                version: None,
                checksum_verified: false,
                shadowed: shadow_probe(&install_dir),
            });
        }
    }

    if let Some(resolved) = read_instance_override(&install_dir)? {
        shadowed = shadow_probe(&install_dir);
        return Ok(ResolvedMxcExecutable {
            source: MxcExecutableSource::InstanceOverride,
            shadowed,
            ..resolved
        });
    }

    match read_managed_manifest(&install_dir) {
        Ok(Some(resolved)) => {
            return Ok(ResolvedMxcExecutable {
                shadowed: None,
                ..resolved
            });
        }
        Ok(None) => {}
        Err(error) => {
            // A manifest exists but is invalid or its checksum does not match. Returning
            // here (instead of continuing to PATH) is the whole point: "installed but
            // tampered with" must never execute.
            return Err(error);
        }
    }

    match find_on_path(env) {
        Some(path) => Ok(ResolvedMxcExecutable {
            path,
            source: MxcExecutableSource::Path,
            version: None,
            checksum_verified: false,
            shadowed,
        }),
        None => Err(MxcResolveError::NotFound),
    }
}

/// Best-effort view of what a managed install would answer, for the CP snapshot.
fn shadow_probe(install_dir: &Path) -> Option<MxcExecutableSource> {
    if install_dir.join(INSTALL_MANIFEST_NAME).is_file() {
        Some(MxcExecutableSource::ManagedManifest)
    } else {
        None
    }
}

fn read_instance_override(
    install_dir: &Path,
) -> Result<Option<ResolvedMxcExecutable>, MxcResolveError> {
    let manifest = install_dir.join(INSTANCE_OVERRIDE_NAME);
    if !manifest.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&manifest)
        .map_err(|error| MxcResolveError::OverrideInvalid(error.to_string()))?;
    let parsed: InstanceOverride = serde_json::from_str(&raw)
        .map_err(|error| MxcResolveError::OverrideInvalid(error.to_string()))?;
    let path = PathBuf::from(parsed.executable.trim());
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(MxcResolveError::OverrideInvalid(
            "override executable must be an absolute path".to_string(),
        ));
    }
    if !path.is_file() {
        return Err(MxcResolveError::InstanceOverrideMissing(path));
    }
    Ok(Some(ResolvedMxcExecutable {
        path,
        source: MxcExecutableSource::InstanceOverride,
        version: None,
        checksum_verified: false,
        shadowed: None,
    }))
}

fn read_managed_manifest(
    install_dir: &Path,
) -> Result<Option<ResolvedMxcExecutable>, MxcResolveError> {
    let manifest_path = install_dir.join(INSTALL_MANIFEST_NAME);
    if !manifest_path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|error| MxcResolveError::ManifestInvalid(error.to_string()))?;
    let parsed: InstallManifest = serde_json::from_str(&raw)
        .map_err(|error| MxcResolveError::ManifestInvalid(error.to_string()))?;
    let declared = PathBuf::from(parsed.executable.trim());
    let path = if declared.is_absolute() {
        declared
    } else {
        install_dir.join(declared)
    };
    if !path.is_file() {
        return Err(MxcResolveError::ManifestInvalid(format!(
            "manifest executable not found: {}",
            path.display()
        )));
    }
    let actual =
        sha256_file(&path).map_err(|error| MxcResolveError::ManifestInvalid(error.to_string()))?;
    let expected = parsed.sha256.trim().to_ascii_lowercase();
    if actual.to_ascii_lowercase() != expected {
        return Err(MxcResolveError::ChecksumMismatch { expected, actual });
    }
    Ok(Some(ResolvedMxcExecutable {
        path,
        source: MxcExecutableSource::ManagedManifest,
        version: Some(parsed.version),
        checksum_verified: true,
        shadowed: None,
    }))
}

fn find_on_path<F>(env: F) -> Option<PathBuf>
where
    F: Fn(&str) -> Option<String>,
{
    let raw = env("PATH")?;
    let separator = if cfg!(windows) { ';' } else { ':' };
    for entry in raw.split(separator) {
        let trimmed = entry.trim().trim_matches('"');
        if trimmed.is_empty() {
            continue;
        }
        let candidate = Path::new(trimmed).join(WXC_EXEC_NAME);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use super::*;

    fn env_of(map: &BTreeMap<String, String>) -> impl Fn(&str) -> Option<String> + Copy + '_ {
        move |key| map.get(key).cloned()
    }

    fn write_exe(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"not really wxc-exec, but a file").expect("write fixture exe");
        path
    }

    fn write_manifest(install_dir: &Path, exe: &Path, version: &str, declared_hash: &str) {
        let body = serde_json::json!({
            "version": version,
            "executable": exe.file_name().unwrap().to_string_lossy(),
            "sha256": declared_hash,
            "sourceUrl": "https://example.invalid/mxc.zip",
            "installedAt": "2026-11-24T00:00:00Z",
        });
        std::fs::write(
            install_dir.join(INSTALL_MANIFEST_NAME),
            serde_json::to_vec(&body).expect("manifest json"),
        )
        .expect("write manifest");
    }

    #[test]
    fn install_dir_defaults_to_product_owned_directory() {
        let mut env = BTreeMap::new();
        env.insert(
            "LOCALAPPDATA".to_string(),
            "C:/Users/x/AppData/Local".to_string(),
        );
        assert_eq!(
            install_dir_from(env_of(&env)),
            PathBuf::from("C:/Users/x/AppData/Local/Xihe/mxc")
        );

        env.insert(
            MXC_INSTALL_DIR_ENV.to_string(),
            " D:/custom/xihe-mxc ".to_string(),
        );
        assert_eq!(
            install_dir_from(env_of(&env)),
            PathBuf::from("D:/custom/xihe-mxc")
        );
    }

    #[test]
    fn env_override_wins_over_managed_install() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install_dir = dir.path();
        let managed = write_exe(install_dir, "managed.exe");
        let hash = sha256_file(&managed).expect("hash");
        write_manifest(install_dir, &managed, "1.1.0", &hash);
        let explicit = write_exe(install_dir, "explicit.exe");

        let mut env = BTreeMap::new();
        env.insert(
            MXC_EXECUTABLE_ENV.to_string(),
            explicit.to_string_lossy().into_owned(),
        );
        env.insert(
            MXC_INSTALL_DIR_ENV.to_string(),
            install_dir.to_string_lossy().into_owned(),
        );

        let resolved = resolve_from(env_of(&env)).expect("env override resolves");
        assert_eq!(resolved.source, MxcExecutableSource::EnvOverride);
        assert_eq!(resolved.path, explicit);
        assert!(
            !resolved.checksum_verified,
            "env override is exempt by design"
        );
        assert_eq!(
            resolved.shadowed,
            Some(MxcExecutableSource::ManagedManifest),
            "snapshot must still show that a managed build exists behind the override"
        );
    }

    #[test]
    fn env_override_pointing_at_a_missing_file_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install_dir = dir.path();
        let managed = write_exe(install_dir, "managed.exe");
        let hash = sha256_file(&managed).expect("hash");
        write_manifest(install_dir, &managed, "1.1.0", &hash);

        let mut env = BTreeMap::new();
        env.insert(
            MXC_EXECUTABLE_ENV.to_string(),
            install_dir.join("nope.exe").to_string_lossy().into_owned(),
        );
        env.insert(
            MXC_INSTALL_DIR_ENV.to_string(),
            install_dir.to_string_lossy().into_owned(),
        );

        let error = resolve_from(env_of(&env)).expect_err("must not fall back to managed");
        assert_eq!(error.code(), "MXC_EXECUTABLE_MISSING");
    }

    #[test]
    fn instance_override_wins_over_managed_install() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install_dir = dir.path();
        let managed = write_exe(install_dir, "managed.exe");
        let hash = sha256_file(&managed).expect("hash");
        write_manifest(install_dir, &managed, "1.1.0", &hash);
        let override_exe = write_exe(install_dir, "override.exe");
        std::fs::write(
            install_dir.join(INSTANCE_OVERRIDE_NAME),
            serde_json::json!({ "executable": override_exe.to_string_lossy() }).to_string(),
        )
        .expect("override json");

        let mut env = BTreeMap::new();
        env.insert(
            MXC_INSTALL_DIR_ENV.to_string(),
            install_dir.to_string_lossy().into_owned(),
        );

        let resolved = resolve_from(env_of(&env)).expect("override resolves");
        assert_eq!(resolved.source, MxcExecutableSource::InstanceOverride);
        assert_eq!(resolved.path, override_exe);
        assert!(!resolved.checksum_verified);
    }

    #[test]
    fn managed_manifest_is_checksum_verified_and_reports_its_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install_dir = dir.path();
        let managed = write_exe(install_dir, "managed.exe");
        let hash = sha256_file(&managed).expect("hash");
        write_manifest(install_dir, &managed, "1.1.0", &hash);

        let mut env = BTreeMap::new();
        env.insert(
            MXC_INSTALL_DIR_ENV.to_string(),
            install_dir.to_string_lossy().into_owned(),
        );
        let resolved = resolve_from(env_of(&env)).expect("managed resolves");
        assert_eq!(resolved.source, MxcExecutableSource::ManagedManifest);
        assert!(resolved.checksum_verified);
        assert_eq!(resolved.version.as_deref(), Some("1.1.0"));
    }

    #[test]
    fn managed_checksum_mismatch_never_falls_back_to_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install_dir = dir.path();
        let managed = write_exe(install_dir, "managed.exe");
        write_manifest(install_dir, &managed, "1.1.0", "deadbeef");

        // A different, valid PATH install exists — it must not be used instead.
        let path_dir = dir.path().join("path");
        std::fs::create_dir_all(&path_dir).expect("path dir");
        write_exe(&path_dir, WXC_EXEC_NAME);

        let mut env = BTreeMap::new();
        env.insert(
            MXC_INSTALL_DIR_ENV.to_string(),
            install_dir.to_string_lossy().into_owned(),
        );
        env.insert("PATH".to_string(), path_dir.to_string_lossy().into_owned());

        let error = resolve_from(env_of(&env)).expect_err("tampered managed build must fail");
        assert_eq!(error.code(), "MXC_CHECKSUM_MISMATCH");
    }

    #[test]
    fn invalid_manifest_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let install_dir = dir.path();
        std::fs::write(install_dir.join(INSTALL_MANIFEST_NAME), b"{not json").expect("write");
        let mut env = BTreeMap::new();
        env.insert(
            MXC_INSTALL_DIR_ENV.to_string(),
            install_dir.to_string_lossy().into_owned(),
        );
        let error = resolve_from(env_of(&env)).expect_err("invalid manifest must fail");
        assert_eq!(error.code(), "MXC_MANIFEST_INVALID");
    }

    #[test]
    fn path_fallback_is_used_only_when_nothing_else_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path_dir = dir.path().join("path");
        std::fs::create_dir_all(&path_dir).expect("path dir");
        let exe = write_exe(&path_dir, WXC_EXEC_NAME);

        let mut env = BTreeMap::new();
        env.insert(
            MXC_INSTALL_DIR_ENV.to_string(),
            dir.path()
                .join("empty-install")
                .to_string_lossy()
                .into_owned(),
        );
        env.insert("PATH".to_string(), path_dir.to_string_lossy().into_owned());

        let resolved = resolve_from(env_of(&env)).expect("path fallback");
        assert_eq!(resolved.source, MxcExecutableSource::Path);
        assert_eq!(resolved.path, exe);
        assert!(!resolved.checksum_verified);
    }

    #[test]
    fn nothing_installed_reports_mxc_not_installed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut env = BTreeMap::new();
        env.insert(
            MXC_INSTALL_DIR_ENV.to_string(),
            dir.path().to_string_lossy().into_owned(),
        );
        env.insert(
            "PATH".to_string(),
            dir.path().join("empty").to_string_lossy().into_owned(),
        );
        let error = resolve_from(env_of(&env)).expect_err("nothing to resolve");
        assert_eq!(error.code(), "MXC_NOT_INSTALLED");
    }
}
