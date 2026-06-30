---
title: DEV-010 - Documentation Layout and Frontmatter Requirements
category: dev-guide
sidebar_order: 10
lang: en
sidebar_group: "Developer Guide"
---

# DEV-010: Documentation Layout and Frontmatter Requirements

## 1. Documentation Location Overview

All public documentation is centralized under `docs/i18n/{lang}/`.

| Location | File Type | lang Value |
| -------- | -------------------------------- | -------------- |
| `docs/i18n/{lang}/*.md` | DEV-NNN, USER-NNN (root docs) | zh-Hans / en |

**Non-public directories** (not subject to frontmatter standardization):

| Directory | Reason |
| ------------------------- | ------------------------------------------------ |
| `plans/` | Plan documents with their own PLAN metadata spec |
| `SPRINTS/` | Sprint documents |
| `.github/`, `.kilo/` | Agent configuration |
| `AGENTS.md` | AI Agent guidance |
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
| `docs/i18n/{lang}/DEV-NNN` | By number: DEV-001=1, ..., DEV-005=5 |
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
