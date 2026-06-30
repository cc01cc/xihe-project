# =============================================================================
# xihe/workspace — 多阶段构建
# Stage 1: 编译 xihe-container-runtime + xihe-mcp-bridge
# Stage 2: 运行时镜像 (ubuntu + nodejs + python + xihe binaries)
# =============================================================================

# Stage 1: Build Rust binaries
FROM rust:1.88 AS builder
WORKDIR /build
COPY packages/runtime/ .
RUN cargo build --release --bin xihe-container-runtime && \
    cargo build --release --bin xihe-mcp-bridge

# Stage 2: Runtime image
FROM ubuntu:22.04

# Install Node.js (22 LTS) + Python 3.12
RUN apt-get update && apt-get install -y \
    curl ca-certificates wget \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs python3.12 \
    && rm -rf /var/lib/apt/lists/*

# xihe binaries (stage 1 artifacts)
COPY --from=builder /build/target/release/xihe-container-runtime /usr/local/bin/
COPY --from=builder /build/target/release/xihe-mcp-bridge /usr/local/bin/

WORKDIR /workspace
CMD ["sleep", "infinity"]
