---
title: "xihe — General-purpose Agent Runtime Platform"
category: dev-guide
sidebar_group: "Overview"
sidebar_order: 1
lang: en
---

<p align="center">
  <strong>xihe</strong> — General-purpose Agent Runtime Platform
</p>

<p align="center">
  Multi-agent orchestration · Tool invocation · Sandbox execution · Access control
</p>

---

> **xihe** (羲和) — the sun goddess in Chinese mythology who drives the sun chariot across the sky.

> Give agents the status and constraints of a human.

> **Development Status**: This project is under active development. APIs and data structures may change. Not recommended for production use.

## Philosophy

**An agent is not a tool — it's a new role on the team.**

An agent shares many similarities with a new hire: it has defined responsibilities, needs resource access permissions, can make mistakes in uncertain situations, and requires trust, supervision, and retrospection. xihe's design philosophy is built on this analogy:

| Concept | People Management | xihe's Agent Management |
|---------|-------------------|------------------------|
| Onboarding | Assign desk and account | Create workspace, assign Runtime instance |
| Responsibility | Job description | Agent prompt + role definition |
| Permission | RBAC permission matrix | CP access control + MCP tool-level authorization |
| Workspace | Physically isolated office | namespace/cgroup/seccomp sandbox isolation |
| Mistakes | People make mistakes, processes backstop | Agent uncertainty backed by sandbox, logs auditable |
| Collaboration | Team-to-team coordination | Multi-agent orchestration + human-agent collaboration |

This is not a metaphor — it's the **first principle** of the product architecture: when agents start acting like humans, they also need to be constrained like humans. Not to limit their capabilities, but to give them a trustworthy boundary within which they can operate freely.

## Features

| Feature | Description |
|---------|-------------|
| **Multi-agent orchestration** | Coordinate multiple agents with role-based access control |
| **Tool invocation** | MCP Server integration for AI agent tool routing |
| **Sandbox execution** | namespace/cgroup/seccomp isolation for safe agent execution |
| **Access control** | RBAC permission matrix for agent resource access |
| **Workspace management** | Isolated workspaces per agent with resource constraints |
| **Audit logging** | Track agent actions and decisions for trust and supervision |
| **Config management** | 3-tier config (system > admin > user) with dynamic updates |

## Architecture

Based on the above philosophy, xihe models "human" and "agent" as two **equal operating entities**, each expressed as an independent module, centrally orchestrated and constrained by the Control Plane (CP):

```mermaid
%%{init: {'theme: 'neutral'}}%%
flowchart LR
    subgraph Entities
        UI["UI<br/>(Human)"]
        AG["Agent<br/>(Agent)"]
    end

    subgraph Management
        CP["Control Plane<br/>Auth · Access · Audit · Routing"]
    end

    subgraph Infrastructure
        RT["Runtime<br/>Sandbox · Filesystem · Process"]
    end

    UI --> CP
    AG --> CP
    CP --> RT
```

| Module | Role | Tech Stack |
|--------|------|------------|
| **UI** | Human interface | Vue 3 + Vite + Tailwind v4 |
| **Agent** | Agent orchestration | Python + FastAPI + LangChain |
| **Control Plane** | Auth, routing, config, audit | Java + Spring Boot 4 |
| **Runtime** | Sandbox execution | Rust + Axum |

## Tech Stack

| Layer | Technology | Version |
|-------|------------|---------|
| UI Framework | Vue 3 + Pinia + vue-router | ^3.5 / ^3.0 / ^5.1 |
| UI Build | Vite + Tailwind CSS 4 + shadcn-vue | ^8 / ^4.3 / ^2.7 |
| CP Framework | Spring Boot 4 + Spring Security + Spring Data JPA | 4.0.6 |
| Agent Framework | FastAPI + LangChain + LangGraph + litellm | — |
| Runtime Framework | rmcp + Axum + Tokio + bollard | 1.7.0 / 0.8.9 / 1.52.3 |
| Database | PostgreSQL 17 + pgvector | — |
| Toolchain | Node 22 / pnpm 10 / Maven 3.9 / uv / Docker | — |

## Quick Start

```bash
# Install dependencies (all modules)
mise run setup

# Start all services (Docker Compose backend + UI on host)
mise run dev:full

# Run full validation (lint + typecheck + build + test)
mise run validate
```

Open http://localhost:12630 in your browser.

## License

Apache 2.0
