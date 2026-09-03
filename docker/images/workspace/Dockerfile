# =============================================================================
# xihe/workspace — 多阶段构建
# Stage 1: 编译 xihe-container-runtime + xihe-mcp-bridge
# Stage 2: 运行时镜像 (node:22-slim + python3 + xihe binaries)
# =============================================================================

# Stage 1: Build Rust binaries
FROM rust:1.88-slim AS builder
WORKDIR /build
COPY packages/runtime/ .
RUN cargo build --release --bin xihe-container-runtime && \
    cargo build --release --bin xihe-mcp-bridge

# Stage 2: Runtime image
# node:22-slim = debian:bookworm-slim + 官方 Node.js 22，省去 nodesource 安装脚本
FROM node:22-slim

# Install Python 3 + 网络工具（沙盒内健康检查与工具调用依赖 curl/wget，见 workspace.rs:299）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 ca-certificates curl wget procps \
    && rm -rf /var/lib/apt/lists/*

# Create independent executor/job users for defense-in-depth (PLAN-235)
RUN groupadd -r xihe-executor && useradd -r -g xihe-executor -m -d /home/xihe-executor xihe-executor \
 && groupadd -r xihe-job && useradd -r -g xihe-job -m -d /home/xihe-job xihe-job \
 && mkdir -p /tmp/xihe-jobs && chmod 1777 /tmp/xihe-jobs

# xihe binaries (stage 1 artifacts)
COPY --from=builder /build/target/release/xihe-container-runtime /usr/local/bin/
COPY --from=builder /build/target/release/xihe-mcp-bridge /usr/local/bin/

WORKDIR /workspace
CMD ["sleep", "infinity"]
