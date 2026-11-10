---
title: xihe Documentation
category: dev-guide
lang: en
sidebar_group: "项目概览"
skip_doc_render: true
---

# xihe Documentation

General-purpose Agent tool platform.

## Developer Guides

- [DEV-001: System Architecture](DEV-001-system-architecture.md)
- [DEV-002: Developer Guide](DEV-002-developer-guide.md)
- [DEV-004: Logging](DEV-004-logging.md)
- [DEV-010: UI Architecture](DEV-010-ui-architecture.md)
- [DEV-011: UI Visual Checklist](DEV-011-ui-checklist.md)
- [DEV-016: MCP Architecture](DEV-016-mcp-architecture.md)
- [DEV-017: Session Architecture](DEV-017-session-architecture.md)
- [DEV-020: E2E Test Strategy](DEV-020-e2e-test-strategy.md)
- [DEV-021: Integration Test Strategy](DEV-021-integration-test-strategy.md)
- [DEV-022: Unit Test Strategy](DEV-022-unit-test-strategy.md)
- [DEV-024: Module Authentication and Key Matrix](DEV-024-authentication-matrix.md)
- [DEV-030: Documentation Layout and Frontmatter](DEV-030-documentation-layout-and-frontmatter.md)
- [DEV-031: Sandbox Backend Contract](DEV-031-sandbox-backend-contract.md)
- [DEV-032: Terminology (Polysemy and Synonyms)](DEV-032-terminology.md)
- [DEV-033: First Run (Gold Path)](DEV-033-first-run-gold-path.md)
- [DEV-034: Contract Map for the Four Spec Surfaces](DEV-034-spec-contract-map.md)
- [RFC-001: Session Domain Model](RFC-001-session-domain-model.md)
- [ADR-001: Session Store Boundary](ADR-001-session-store-boundary.md)

## Project SPEC (Agent/GitHub-only)

- `spec/README.md`: XH project contract entry at repository root; excluded from the documentation site
- `spec/writing-guide.md`: Chinese-first SPEC writing, profiles, Mermaid/ASCII, and verification rules

### Chinese-only guides (not translated yet)

These guides exist only as Chinese originals in [`zh-Hans`](../zh-Hans/) today. Where an English page needs one, it links to the Chinese file with a `(zh)` marker instead of keeping a stale English stub — that is the convention this tree follows (see DEV-033 and DEV-034 for examples). Gap census, per-document decisions and the translation backlog are recorded in `plans/PLAN-0763-XH-api-contract-docs/evidence/en-docs-gap.md`.

- [DEV-003: Configuration Management](../zh-Hans/DEV-003-config-management.md)
- [DEV-012: UI/UX Reference Projects](../zh-Hans/DEV-012-ui-ux-references.md)
- [DEV-013: Agent Architecture](../zh-Hans/DEV-013-agent-architecture.md)
- [DEV-014: CP Architecture](../zh-Hans/DEV-014-control-plane-architecture.md)
- [DEV-015: Runtime Architecture](../zh-Hans/DEV-015-runtime-architecture.md)
- [DEV-018: Known Issues](../zh-Hans/DEV-018-known-issues.md)
- [DEV-019: Database Schema](../zh-Hans/DEV-019-database-schema.md)
- [DEV-023: Test Mock Strategy](../zh-Hans/DEV-023-test-mock-strategy.md)
- [DEV-025: Agent Evaluation](../zh-Hans/DEV-025-agent-evaluation.md)

The Chinese [README](../zh-Hans/README.md) is **intentionally** zh-only: the repository root `README.md` is the English GitHub facade and the Chinese docs page is a separate artefact (DEV-030 §layout).

## Engineering Blog (narrative)

- [blog/](blog/README.md): design rationale and post-mortems (date-named, no DEV numbering)
