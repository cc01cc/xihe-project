FROM rust:1.88-slim AS builder
WORKDIR /app

# ── Layer 1: Dependency cache (dummy build) ──────────────────────────
# Only invalidated when Cargo.toml or Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && \
    echo 'fn main() {}' > src/main.rs && \
    echo '' > src/lib.rs && \
    echo 'fn main() {}' > src/container_runtime.rs && \
    echo 'fn main() {}' > src/mcp_bridge.rs && \
    echo 'fn main() {}' > src/stdio_fixture.rs && \
    cargo build --release && \
    rm -rf src

# ── Layer 2: Real source build ───────────────────────────────────────
# Only recompiles changed source files; dependencies stay cached.
# touch 强制源码 mtime 新于 dummy 层指纹，否则 cargo 可能误判 fresh 而保留 stub 二进制
COPY src ./src
RUN find src -name '*.rs' -exec touch {} + && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/xihe-runtime /usr/local/bin/
COPY --from=builder /app/target/release/xihe-container-runtime /usr/local/bin/
COPY --from=builder /app/target/release/xihe-mcp-bridge /usr/local/bin/
EXPOSE 8001
CMD ["xihe-runtime"]
