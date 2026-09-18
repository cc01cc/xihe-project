# =============================================================================
# xihe/workspace — 多阶段构建
# Stage 1: 编译 xihe-container-runtime（PLAN-0347：xihe-mcp-bridge 已退役）
# Stage 2: 运行时镜像 (node:22-slim + python3 + xihe binaries)
# =============================================================================

# Stage 1: Build Rust binaries
# base 与 rust-toolchain.toml 对齐（1.97.1）且固定 bookworm 发行版：工具链随镜像
# 自带，消除此前每次源码变更重建时重下 rustup 工具链的开销；bookworm 与运行时
# 阶段（node:24-bookworm-slim）同族，避免 trixie 新 glibc 产物在运行镜像缺 GLIBC。
# BuildKit cache mounts 复用 crates registry 与 target（target 用 bookworm 专用
# cache id，防止跨发行族复用旧产物），源码变更只做增量重编。
FROM rust:1.97.1-slim-bookworm AS builder
RUN rustup component add rustfmt clippy
WORKDIR /build
COPY packages/runtime/ .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target,id=workspace-target-bookworm \
    cargo build --release --bin xihe-container-runtime \

 && mkdir -p /build/out \
 && cp target/release/xihe-container-runtime /build/out/

# Stage 2: Runtime image
# node:24-bookworm-slim = debian:bookworm-slim + 官方 Node.js 24（对齐 workspace
# Node 24 标准；bookworm 与 builder 同发行族，glibc 2.36 一致）
FROM node:24-bookworm-slim

# Install Python 3 + 网络工具（沙盒内健康检查与工具调用依赖 curl/wget，见 workspace.rs:299）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 ca-certificates curl wget procps \
    && rm -rf /var/lib/apt/lists/*

# Create independent executor/job users for defense-in-depth (PLAN-235)
RUN groupadd -r xihe-executor && useradd -r -g xihe-executor -m -d /home/xihe-executor xihe-executor \
 && groupadd -r xihe-job && useradd -r -g xihe-job -m -d /home/xihe-job xihe-job \
 && mkdir -p /tmp/xihe-jobs && chmod 1777 /tmp/xihe-jobs

# xihe binaries (stage 1 artifacts)
COPY --from=builder /build/out/xihe-container-runtime /usr/local/bin/

WORKDIR /workspace
CMD ["sleep", "infinity"]
