//! PLAN-0347 T1.1：SandboxBackend 接缝（接口声明 + Docker 实现 + 能力声明）。
//!
//! 契约来源：`plans/PLAN-0329-XH-sandbox-backend-contract/spec/sandbox-backend-contract.md`
//! （公开页 DEV-031）。本模块是接缝的唯一定义点：接缝之上不得出现 Docker 概念
//! （容器名 / IP / 端口发布 / `network_mode` / 容器内 pid），能力缺失必须显式
//! `Unsupported`，且 `declared` 与 `probed` 冲突时 fail-closed（0329 §3 / 不变式 I3）。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::error::{Result, RuntimeError};
use crate::executor::WorkspaceExecutionRouter;
use crate::hydrate::WorkspaceEnsurer;
use crate::sandbox::SecurityProfile;
use crate::workspace::WorkspaceManager;

/// 免 `async-trait` 依赖的装箱 Future 别名。
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 能力声明：`declared`（声称支持）/ `probed`（实测结论，`None` = 未探测）/ `reason`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capability {
    pub declared: bool,
    pub probed: Option<bool>,
    pub reason: Option<String>,
}

impl Capability {
    /// 声明支持、尚未实测。
    pub fn declared() -> Self {
        Self {
            declared: true,
            probed: None,
            reason: None,
        }
    }

    /// 声明支持且实测通过。
    pub fn probed_ok() -> Self {
        Self {
            declared: true,
            probed: Some(true),
            reason: None,
        }
    }

    /// 显式不支持。
    pub fn unsupported(reason: impl Into<String>) -> Self {
        Self {
            declared: false,
            probed: Some(false),
            reason: Some(reason.into()),
        }
    }

    /// 可用性判定（不变式 I3）：未探测按声明；`declared=true` 但实测失败 → fail-closed。
    pub fn is_usable(&self) -> bool {
        self.declared && self.probed != Some(false)
    }

    /// `declared` 与 `probed` 冲突（fail-closed 触发点）。
    pub fn is_mismatch(&self) -> bool {
        self.declared && self.probed == Some(false)
    }
}

/// Docker 后端 v1 能力表（决策 #10：仅 `session` 做真实探针，其余按实现事实声明）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub ensure: Capability,
    pub destroy: Capability,
    pub execute: Capability,
    pub session: Capability,
    pub pause_resume: Capability,
    pub network_policy: Capability,
    pub fs_transfer: Capability,
}

/// 目标态能力声明。`session` 的真实探针随 T1.3（session 承载实现）写入。
pub fn docker_backend_capabilities() -> Capabilities {
    Capabilities {
        ensure: Capability::declared(),
        destroy: Capability::declared(),
        execute: Capability::declared(),
        // 契约档 1（长驻会话）；探针随 T1.3 落地
        session: Capability::declared(),
        // Docker pause/unpause 保留进程（cgroup freezer），不假装 fs 快照
        pause_resume: Capability::declared(),
        // strict = network none / coding = bridge + 审计代理
        network_policy: Capability::declared(),
        // 以 bind mount 承载；挂载优先（0329 §4.5）
        fs_transfer: Capability::declared(),
    }
}

/// 沙盒规格（上层不透明传递；不含宿主路径等存储细节）。
#[derive(Debug, Clone, PartialEq)]
pub struct SandboxSpec {
    pub workspace_id: String,
    pub image: String,
    pub profile: SecurityProfile,
}

/// 沙盒句柄：上层只持有不透明标识，不接触容器名 / 容器内路径。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxHandle {
    pub workspace_id: String,
}

/// 能力缺失 / 冲突的标准错误（显式 UNSUPPORTED，禁止静默降级）。
pub fn unsupported(capability: &str, reason: &str) -> RuntimeError {
    RuntimeError::Unsupported {
        capability: capability.to_string(),
        reason: reason.to_string(),
    }
}

/// 能力前置检查：不可用时返回显式错误（I3）。
pub fn require_capability(capability: &str, cap: &Capability) -> Result<()> {
    if cap.is_usable() {
        return Ok(());
    }
    let reason = match (&cap.reason, cap.is_mismatch()) {
        (Some(reason), _) => reason.clone(),
        (None, true) => "declared/probed mismatch (fail-closed)".to_string(),
        (None, false) => "capability not declared".to_string(),
    };
    Err(unsupported(capability, &reason))
}

/// 执行层接缝（0329 §2）：必备动词 = `ensure` / `destroy` / `execute` / `capabilities`。
/// 可选能力（`session` 等）按能力声明扩展；缺失能力显式失败，不做静默降级。
pub trait SandboxBackend: Send + Sync {
    fn capabilities(&self) -> Capabilities;

    fn ensure<'a>(&'a self, spec: &'a SandboxSpec) -> BoxFuture<'a, Result<SandboxHandle>>;

    fn destroy<'a>(&'a self, handle: &'a SandboxHandle) -> BoxFuture<'a, Result<()>>;

    fn execute<'a>(
        &'a self,
        handle: &'a SandboxHandle,
        operation: &'a str,
        payload: Value,
    ) -> BoxFuture<'a, Result<Value>>;
}

/// Docker 实现：唯一后端（决策 #2）；内部复用既有 ensure / execute / destroy 路径。
pub struct DockerBackend {
    ensurer: Arc<WorkspaceEnsurer>,
    manager: Arc<Mutex<WorkspaceManager>>,
    router: Arc<WorkspaceExecutionRouter>,
}

impl DockerBackend {
    pub fn new(
        ensurer: Arc<WorkspaceEnsurer>,
        manager: Arc<Mutex<WorkspaceManager>>,
        router: Arc<WorkspaceExecutionRouter>,
    ) -> Self {
        Self {
            ensurer,
            manager,
            router,
        }
    }
}

impl SandboxBackend for DockerBackend {
    fn capabilities(&self) -> Capabilities {
        docker_backend_capabilities()
    }

    fn ensure<'a>(&'a self, spec: &'a SandboxSpec) -> BoxFuture<'a, Result<SandboxHandle>> {
        Box::pin(async move {
            require_capability("ensure", &self.capabilities().ensure)?;
            self.ensurer
                .ensure_workspace_materialized(&spec.workspace_id)
                .await?;
            Ok(SandboxHandle {
                workspace_id: spec.workspace_id.clone(),
            })
        })
    }

    fn destroy<'a>(&'a self, handle: &'a SandboxHandle) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            require_capability("destroy", &self.capabilities().destroy)?;
            let mut manager = self.manager.lock().await;
            manager.delete_workspace(&handle.workspace_id).await
        })
    }

    fn execute<'a>(
        &'a self,
        handle: &'a SandboxHandle,
        operation: &'a str,
        payload: Value,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            require_capability("execute", &self.capabilities().execute)?;
            self.router
                .execute_op(&handle.workspace_id, operation, payload)
                .await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_fail_closed_on_mismatch() {
        let cap = Capability {
            declared: true,
            probed: Some(false),
            reason: None,
        };
        assert!(!cap.is_usable());
        assert!(cap.is_mismatch());
        let error = require_capability("execute", &cap).unwrap_err();
        assert!(matches!(error, RuntimeError::Unsupported { .. }));
        assert!(
            error.to_string().contains("failed-closed")
                || error.to_string().contains("fail-closed")
        );
    }

    #[test]
    fn capability_undeclared_is_unsupported_with_reason() {
        let cap = Capability::unsupported("no consumer");
        assert!(!cap.is_usable());
        let error = require_capability("session", &cap).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Capability unsupported: session (no consumer)"
        );
    }

    #[test]
    fn docker_capabilities_v1_table() {
        let caps = docker_backend_capabilities();
        for (name, cap) in [
            ("ensure", &caps.ensure),
            ("destroy", &caps.destroy),
            ("execute", &caps.execute),
            ("pause_resume", &caps.pause_resume),
            ("network_policy", &caps.network_policy),
            ("fs_transfer", &caps.fs_transfer),
        ] {
            assert!(cap.is_usable(), "{name} must be usable");
            assert_eq!(cap.probed, None, "{name} probe lands with its consumer");
        }
        // session 已声明；真实探针随 T1.3 写入
        assert!(caps.session.declared);
        assert_eq!(caps.session.probed, None);
    }

    struct StubBackend;

    impl SandboxBackend for StubBackend {
        fn capabilities(&self) -> Capabilities {
            let mut caps = docker_backend_capabilities();
            caps.session = Capability::unsupported("stub backend");
            caps
        }

        fn ensure<'a>(&'a self, _spec: &'a SandboxSpec) -> BoxFuture<'a, Result<SandboxHandle>> {
            Box::pin(async move { Err(unsupported("ensure", "stub backend")) })
        }

        fn destroy<'a>(&'a self, _handle: &'a SandboxHandle) -> BoxFuture<'a, Result<()>> {
            Box::pin(async move { Err(unsupported("destroy", "stub backend")) })
        }

        fn execute<'a>(
            &'a self,
            _handle: &'a SandboxHandle,
            _operation: &'a str,
            _payload: Value,
        ) -> BoxFuture<'a, Result<Value>> {
            Box::pin(async move { Err(unsupported("execute", "stub backend")) })
        }
    }

    #[tokio::test]
    async fn trait_object_unsupported_paths_are_explicit() {
        let backend: Arc<dyn SandboxBackend> = Arc::new(StubBackend);
        let spec = SandboxSpec {
            workspace_id: "ws_test".to_string(),
            image: "xihe/workspace:latest".to_string(),
            profile: SecurityProfile::Strict,
        };
        let error = backend.ensure(&spec).await.unwrap_err();
        assert!(matches!(error, RuntimeError::Unsupported { .. }));
        let handle = SandboxHandle {
            workspace_id: "ws_test".to_string(),
        };
        assert!(backend.destroy(&handle).await.is_err());
        assert!(
            backend
                .execute(&handle, "read_file", Value::Null)
                .await
                .is_err()
        );
        assert!(Capability::unsupported("x").reason.is_some());
    }

    /// PLAN-0347 Q7-A：`cfg(test)` 内存假后端驱动完整接缝周期，证明"可替换实现
    /// 而不改调用方"（不发布、不建 factory）。
    #[tokio::test]
    async fn seam_drives_ensure_execute_destroy_through_in_memory_backend() {
        use std::sync::Mutex as StdMutex;

        #[derive(Debug, PartialEq)]
        enum Op {
            Ensure(String),
            Execute(String),
            Destroy(String),
        }

        struct InMemoryBackend {
            ops: StdMutex<Vec<Op>>,
        }

        impl InMemoryBackend {
            fn new() -> Self {
                Self {
                    ops: StdMutex::new(Vec::new()),
                }
            }

            fn recorded(&self) -> Vec<String> {
                self.ops
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|op| match op {
                        Op::Ensure(id) | Op::Execute(id) | Op::Destroy(id) => id.clone(),
                    })
                    .collect()
            }
        }

        impl SandboxBackend for InMemoryBackend {
            fn capabilities(&self) -> Capabilities {
                docker_backend_capabilities()
            }

            fn ensure<'a>(&'a self, spec: &'a SandboxSpec) -> BoxFuture<'a, Result<SandboxHandle>> {
                self.ops
                    .lock()
                    .unwrap()
                    .push(Op::Ensure(spec.workspace_id.clone()));
                Box::pin(async move {
                    Ok(SandboxHandle {
                        workspace_id: spec.workspace_id.clone(),
                    })
                })
            }

            fn destroy<'a>(&'a self, handle: &'a SandboxHandle) -> BoxFuture<'a, Result<()>> {
                self.ops
                    .lock()
                    .unwrap()
                    .push(Op::Destroy(handle.workspace_id.clone()));
                Box::pin(async { Ok(()) })
            }

            fn execute<'a>(
                &'a self,
                handle: &'a SandboxHandle,
                operation: &'a str,
                _payload: Value,
            ) -> BoxFuture<'a, Result<Value>> {
                self.ops
                    .lock()
                    .unwrap()
                    .push(Op::Execute(format!("{operation}:{}", handle.workspace_id)));
                Box::pin(async { Ok(serde_json::json!({"ok": true})) })
            }
        }

        let memory = Arc::new(InMemoryBackend::new());
        let backend: Arc<dyn SandboxBackend> = memory.clone();
        let spec = SandboxSpec {
            workspace_id: "ws_seam".to_string(),
            image: "xihe/workspace:latest".to_string(),
            profile: SecurityProfile::Strict,
        };
        let handle = backend.ensure(&spec).await.unwrap();
        let value = backend
            .execute(
                &handle,
                "read_file",
                serde_json::json!({"path": "/workspace/a"}),
            )
            .await
            .unwrap();
        assert_eq!(value["ok"], serde_json::json!(true));
        backend.destroy(&handle).await.unwrap();
        assert_eq!(
            memory.recorded(),
            vec![
                "ws_seam".to_string(),
                "read_file:ws_seam".to_string(),
                "ws_seam".to_string()
            ]
        );
    }
}
