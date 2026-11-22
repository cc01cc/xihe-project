---
title: DEV-030 - Documentation Layout and Frontmatter Requirements
category: dev-guide
sidebar_order: 30
lang: en
sidebar_group: "Developer Guide"
---

# DEV-030: Documentation Layout and Frontmatter Requirements

## 1. Documentation Location Overview

All public documentation is centralized under `docs/i18n/{lang}/`.

| Location | File Type | lang Value |
| -------- | -------------------------------- | -------------- |
| `docs/i18n/{lang}/*.md` | DEV-NNN, USER-NNN (root docs) | zh-Hans / en |

The project-root `spec/` directory contains Agent/GitHub-only XH contracts. It is not part of the public documentation site and does not use this frontmatter or sidebar scheme. Its canonical entry is `spec/README.md` and its writing guide is `spec/writing-guide.md`; this DEV document and INDEX.md only provide navigation.

**Non-public directories** (not subject to frontmatter standardization):

| Directory | Reason |
| ------------------------- | ------------------------------------------------ |
| `plans/` | Plan documents with their own PLAN metadata spec |
| `SPRINTS/` | Sprint documents |
| `.github/`, `.kilo/` | Agent configuration |
| `AGENTS.md` | AI Agent guidance |
| `spec/` | Agent/GitHub-only project SPEC; excluded from the documentation site |
| `CHANGELOG.md` | Changelog with its own format |
| `.changeset/` | Changeset files |

## 2. Unified Frontmatter Schema

All public documents must use the following unified frontmatter schema:

```yaml
---
title: "Document Title"              # text, required. Document display title
category: dev-guide              # text, required. Enum values see below
sidebar_order: 1                  # number, optional. Sort order within category
lang: zh-Hans                     # text, required. BCP 47 language tag
tags:                             # list, optional. Tag list
    - mcp
    - routing
status: active                    # text, optional. active | deprecated | draft
created: 2026-05-28               # date, optional. ISO 8601, creation date
updated: 2026-06-03               # date, optional. ISO 8601, last update date
---
```

### 2.1. category Enum Values

| Value | Scope | LYJ sidebar section |
| ----- | -------------------------------- | ---------------- |
| `user-guide` | USER-* user guides | User Manual |
| `dev-guide` | DEV-* developer docs | Developer Manual |

> `config`, `api`, `adr` and other categories are not yet rendered in LYJ. If new sections are needed, the `catOrder` in `LingYiJu/packages/project/generate-config.ts` must be updated simultaneously.

### 2.2. lang Field

BCP 47 language tag, using script-based rather than region-based:

| Tag | Meaning | Use Case |
| ---- | -------------------- | ------------------ |
| `zh-Hans` | Simplified Chinese (writing system) | Default language, region-neutral |
| `en` | English | English translation |

### 2.3. Documents Skipped by LYJ Site Rendering

The following files are automatically excluded by LYJ and don't require special marking:

| Exclusion Rule | Effect | Basis |
| -------------- | ------ | ----- |
| `**/INDEX.md` | All INDEX.md files don't generate pages | LYJ `DocSource.excludePatterns` |
| No frontmatter | Skip rendering | `scan()` detection |
| Category not in `catOrder` | Skip rendering | `scan()` detection |

The `skip_doc_render` field remains effective as a per-file override switch, but normally doesn't need to be set.

### 2.4. Field Requirements by Location

| Location | Required Fields | Optional Fields |
| ------------------------------------------- | ---------------------- | ----------------------------------------------------- |
| `docs/i18n/{lang}/*.md` (root docs) | title, category, lang | sidebar_order, tags, status, created, updated |

> INDEX.md is excluded by LYJ side, no frontmatter constraints needed.

### 2.5. sidebar_order Assignment Strategy

| File Pattern | Strategy |
| ---------------------- | ----------- |
| `docs/i18n/{lang}/DEV-NNN` | By number: DEV-001=1, DEV-002=2, … |
| `docs/i18n/{lang}/USER-NNN` | =1 |

## 3. Document Numbering Convention

| Prefix | Range | Description |
| ---- | ---- | ---- |
| DEV-NNN | Developer Guide | Architecture, dev environment, logging, UI specs, etc. |
| USER-NNN | User Manual | Operation guide, quick start |

ADR documents under `adr/` directory use an independent numbering system (`ADR-NNN-title.md`).

## 4. New Document Checklist

When adding a new public document, ensure:

1. [ ] File is located under the corresponding subdirectory in `docs/i18n/{lang}/`
2. [ ] Contains unified frontmatter: `title`, `category`, `lang` are required
3. [ ] `sidebar_order` doesn't conflict with existing documents in the same category
4. [ ] Only documents for GitHub display can omit frontmatter, no doc site rendering needed
5. [ ] Files intended for doc site rendering must have frontmatter with `category` in allowed values
6. [ ] `lang` value must match the language of the directory it's in
7. [ ] File naming follows `[PREFIX-]NNN-name.md` format (e.g., `DEV-001-system-architecture.md`)

INDEX.md and other pure navigation files don't need special settings — LYJ side automatically excludes them.

## 5. References

- `CMTX docs/i18n/zh-Hans/DEV-010-documentation-layout-and-frontmatter.md` — CMTX original spec (with full research background)
- `LingYiJu/packages/project/generate-config.ts` — LYJ side scanning and exclusion logic

## 6. Style System (PLAN-241 readability baseline)

Three principles: (1) **inverted pyramid** — an H1 lead-in (audience + what is covered + prerequisites), conclusion before detail; (2) **tables first** — comparisons, matrices and checklists go into tables, not paragraphs; (3) **progressive disclosure** — keep conclusions and common paths in the body, move provenance, history and exhaustive lists into an appendix.

- Headings: exactly one H1, H2/H3 numbered, no H4+ (split into a table or an appendix instead).
- Diagrams: pick by content, not "mermaid by default" — flows/sequences/states use mermaid (subgraphs carry detail), directory trees and level overviews stay ASCII (mermaid has no better type); a converted diagram must map one-to-one onto the original information (PLAN-241 Decision 7: compressing conversions lose information); every diagram notes the code anchor. No new ASCII flowcharts.
- Duplicated content: each document keeps a summary plus a pointer to the owning document (transport owner DEV-010, attachment domain owner DEV-017) so every page stays self-contained.
- Symbols: keep the ✅/⚠️/❌/→ scanning markers (project exception, see below); Chinese/English terminology is paired on first use, Chinese afterwards.

> Project exception: the workspace DOC-002 rule asks for pure ASCII without emoji. This series keeps the four markers ✅/⚠️/❌/→ for scanability and consistency with existing documents; everything else still follows DOC-002 (no other emoji or decorative characters).

### 6.1 Diagram selection (revised 2026-11-22)

The "Diagrams" line in §6 becomes executable here: **Mermaid by default** — structure, layering, region naming and comparison matrices use Mermaid whenever they map to "nodes + edges"; **only spatial arrangements Mermaid cannot express** (free-form geometry, non-graph layouts) fall back to inline SVG.

| Content shape | First choice | Note |
| --- | --- | --- |
| Structure, layering, region naming, comparison matrices | Mermaid (`flowchart` / `subgraph`) | use it whenever the content maps to nodes and edges; subgraphs carry detail, the pipeline renders it natively |
| Flows, sequences, state machines | Mermaid | the existing 28 blocks across 15 documents stay as they are |
| Spatial arrangements Mermaid cannot express | inline SVG (raw HTML, script-generated) | free-form geometry / non-graph layouts only, and must pass the three hard rules below |
| Directory trees, level overviews | ASCII | Mermaid has no better type (§6 original rule) |

**Three hard rules for the SVG exception** (apply only to the "spatial arrangement" row above):

1. **Script-generated**: coordinates come from a script; never hand-write `path` / `rect` coordinates — hand-written ones drift into dangling segments, off-centre layouts and line ends poking into boxes (the old DEV-001 diagram is the example).
2. **Geometry-checked**: before committing, validate line endpoints and node bounding boxes — no dangling start/end points, no clipping, no overlaps; keep the checker script and its readings as evidence.
3. **Both languages in the same batch**: zh and en in one change (labels localised too), otherwise the heading pairing in `check:dev-i18n-drift` gains hits.

**Image sources**: Mermaid stays the default; when a bitmap is needed, use a relative path (`![](./assets/x.png)`), which the EW doc-site importer publishes at import time — "local relative path + publish on import" is the user's 2026-11-22 decision, so embedding every image inside the `.md` is no longer required. Labels still come only from the owning document's name table (for example DEV-010 §10.1.1), and both languages ship together.

**Final artifact shape** (produced by a script — do not hand-edit coordinates; `viewBox` for the ratio, `width="100%"` to stay inside the body column, `role="img"` + `<title>` for accessibility):

```html
<svg viewBox="0 0 660 300" width="100%" role="img">
  <title>diagram title</title>
  <rect x="12" y="12" width="200" height="48" rx="6" fill="#f9fafb" stroke="#9ca3af"/>
  <text x="112" y="41" font-size="12" fill="#374151" text-anchor="middle">sanctioned name</text>
  <path d="M212 36 L260 36" stroke="#9ca3af"/>
</svg>
```

> Do not wrap the markup in an `svg` code fence: the fence-language whitelist (`packages/libs/utils/src/code-fence.ts:12`) has no `svg`, so it is highlighted as plain text and printed as code. Keep it as raw inline HTML.

## 7. Documentation Ownership (PLAN-239 drift gate)

Every document has an owning module; a PLAN that changes that module's code must update the owning document in the same batch (see the wrap-up checklist in `A03-xihe/AGENTS.md`).

| Module | Owning document |
| --- | --- |
| Global architecture/protocol | DEV-001 |
| Environment/runtime/debugging | DEV-002 |
| Configuration | DEV-003 |
| Logging | DEV-004 |
| UI | DEV-010/011/012 |
| Agent | DEV-013 |
| CP | DEV-014 |
| Runtime | DEV-015 |
| MCP | DEV-016 |
| Session | DEV-017 |
| DB schema | DEV-019 |
| Testing | DEV-020/021/022/023 |
| Authentication/security | DEV-024 |
| User-visible behaviour | USER-001 |

## Appendix: Glossary (series-wide; Chinese/English paired on first use)

| English | Chinese | Note |
| --- | --- | --- |
| materialization | 物化 | Runtime creates a Sandbox / loads a Workspace on demand |
| ExecutionSpec | 执行规格 | Workspace execution description issued by CP; the Runtime fetches it by `workspaceId` |
| storageRef | 存储引用 | Persistent locator of a WorkspaceStorage |
| generation | 连接代数 | Monotonic version of an SSE connection, isolating old and new emitters |
| run / runId | 轮次 | One model execution triggered by `POST /api/v1/chat` |
| MessagePart | 消息分区 | Content unit of a streaming message (text/reasoning/citation/artifact) |
| tool namespace | 工具命名空间 | On-demand isolation via a `serverId__` prefix (sticky and persisted, never promoted; see DEV-016 §4) |
| serverId | 服务标识 | Routing key: STDIO uses the top-level key of the user config, remote uses the `mcp_servers` row |
| tool generation | 工具代数 | Incremented per merged `tools/list`, recorded with the audit tuple for historical replay |
| no-auth remote | 免鉴权远端 | Public remote server with `authMode=no-auth`; skips the CP token broker |
| Sandbox | 沙盒 | Execution-entity abstraction the agent operates on (`SandboxBackend` seam): the docker backend is a per-workspace container, while `windows-mxc` / `windows-host` are host-side execution surfaces |
| bridge (retired) | 桥 | The former in-container process bridging a STDIO MCP server to HTTP, deleted by PLAN-0347; now a long-lived host `exec attach` session (see DEV-016 §5) |
| profile (Strict/Coding/Isolated) | 画像 | Container isolation level of the docker backend; MXC/host backends have no such dimension (MXC uses a policy path allowlist, host has no process-level isolation) |
