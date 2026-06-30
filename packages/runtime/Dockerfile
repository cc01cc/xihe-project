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
    cargo build --release && \
    rm -rf src

# ── Layer 2: Real source build ───────────────────────────────────────
# Only recompiles changed source files; dependencies stay cached.
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/xihe-runtime /usr/local/bin/
COPY --from=builder /app/target/release/xihe-container-runtime /usr/local/bin/
COPY --from=builder /app/target/release/xihe-mcp-bridge /usr/local/bin/
EXPOSE 8001
CMD ["xihe-runtime"]
