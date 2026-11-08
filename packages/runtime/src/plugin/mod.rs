//! T2.4a：Runtime 侧的本地 stdio 插件 runner（进程托管）。
//!
//! # 本模块负责什么
//!
//! 起一个**宿主**子进程，用换行分隔 JSON-RPC 跟它对话：独立 PID、启动/请求超时、
//! stderr 尾巴留证、崩溃判定与回收（进程退出必被 `wait`/`try_wait` 收掉，不留僵尸）、
//! 限并发。**无共享内存**：只经 stdin/stdout 管道交互，不 mmap、不传共享 buffer、
//! 不落临时文件。
//!
//! # 本模块**不**负责什么（刻意留白，别据此宣称 T2.4 已完成）
//!
//! - CP internal 管理面与健康端点（`/internal/v1/...`）：属 T2.4b，本卡不碰 CP。
//! - binding 的五态机（`pending→enabled→degraded→suspended→disabled`）：属 T2.5。
//!   本模块只有进程级状态 [`runner::RunnerState`]，两套状态不要合并成一个字段。
//! - 真实插件包（B-6 的 `official.doc-index`）：属 T2.4b；本卡 L0 用
//!   `xihe-plugin-fixture` 二进制，那是**工艺样本，不是产品样本**。
//! - OS 级沙箱：D-61 只承诺"进程边界"，不承诺文件系统/网络隔离。
//!
//! # 与既有 `mcp_session` 的关系
//!
//! `mcp_session` 在**工作区容器内**用 `docker exec` 托管 stdio MCP 服务；本模块在**宿主**
//! 起进程（插件跑在宿主边界上，不经容器）。帧切分与响应配对直接复用
//! [`crate::mcp_session::split_complete_lines`] 与 [`crate::mcp_session::match_response`]，
//! 避免同一协议出现两套口径。

pub mod host;
pub mod runner;
pub mod spec;

pub use host::{HostError, PluginRunnerHost};
pub use runner::{PluginRunner, RunnerError, RunnerHealth, RunnerState};
pub use spec::{PluginRunnerSpec, SpecError};
