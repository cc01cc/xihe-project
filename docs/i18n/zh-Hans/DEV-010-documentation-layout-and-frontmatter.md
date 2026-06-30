---
title: DEV-010 - 文档布局与 Frontmatter 要求
category: dev-guide
sidebar_order: 10
lang: zh-Hans
sidebar_group: "开发指南"
---

# DEV-010: 文档布局与 Frontmatter 要求

## 1. 文档位置概览

所有公开文档集中在 `docs/i18n/{lang}/` 下。

| 位置 | 文件类型 | lang 值 |
| ---- | -------------------------------- | -------------- |
| `docs/i18n/{lang}/*.md` | DEV-NNN, USER-NNN（根文档） | zh-Hans / en |

**非公开目录**（不纳入 frontmatter 标准化）：

| 目录 | 原因 |
| ------------------------- | ------------------------------------------------ |
| `plans/` | 计划文档，有自身 PLAN metadata 规范 |
| `SPRINTS/` | Sprint 文档 |
| `.github/`、`.kilo/` | Agent 配置 |
| `AGENTS.md` | AI Agent 指引 |
| `CHANGELOG.md` | 变更日志，有自身格式 |
| `.changeset/` | Changeset 文件 |

## 2. 统一 Frontmatter Schema

所有公开文档必须使用以下统一的 frontmatter schema：

```yaml
---
title: "文档标题"              # text, 必填。文档显示标题
category: dev-guide              # text, 必填。枚举值见下方
sidebar_order: 1                  # number, 可选。同 category 内排序
lang: zh-Hans                     # text, 必填。BCP 47 语言标签
tags:                             # list, 可选。标签列表
    - mcp
    - routing
status: active                    # text, 可选。active | deprecated | draft
created: 2026-05-28               # date, 可选。ISO 8601，创建日期
updated: 2026-06-03               # date, 可选。ISO 8601，最后更新日期
---
```

### 2.1. category 枚举值

| 值 | 适用范围 | LYJ sidebar 分区 |
| ----- | -------------------------------- | ---------------- |
| `user-guide` | USER-* 用户指南 | 用户手册 |
| `dev-guide` | DEV-* 开发者文档 | 开发手册 |

> `config`、`api`、`adr` 等 category 在 LYJ 中暂未渲染。如需新增分区，需同步更新 `LingYiJu/packages/project/generate-config.ts` 的 `catOrder`。

### 2.2. lang 字段

BCP 47 语言标签，使用 script-based 而非 region-based：

| 标签 | 含义 | 适用场景 |
| ---- | -------------------- | ------------------ |
| `zh-Hans` | 简体中文（书写系统） | 默认语言，地域中立 |
| `en` | 英语 | 英文翻译 |

### 2.3. 被 LYJ 站点跳过渲染的文档

以下文件会被 LYJ 自动排除，不需要特殊标记：

| 排除规则 | 效果 | 依据 |
| -------- | ---- | ---- |
| `**/INDEX.md` | 所有 INDEX.md 不生成页面 | LYJ `DocSource.excludePatterns` |
| 无 frontmatter | 跳过渲染 | `scan()` 检测 |
| category 不在 `catOrder` 中 | 跳过渲染 | `scan()` 检测 |

`skip_doc_render` 字段作为每文件覆盖开关仍然有效，但正常情况下不需要设置。

### 2.4. 各位置字段要求

| 位置 | 必填字段 | 可选字段 |
| ------------------------------------------- | ---------------------- | ----------------------------------------------------- |
| `docs/i18n/{lang}/*.md` (根文档) | title, category, lang | sidebar_order, tags, status, created, updated |

> INDEX.md 由 LYJ 端排除，无需 frontmatter 约束。

### 2.5. sidebar_order 分配策略

| 文件模式 | 策略 |
| ---------------------- | ----------- |
| `docs/i18n/{lang}/DEV-NNN` | 按编号：DEV-001=1, ..., DEV-005=5 |
| `docs/i18n/{lang}/USER-NNN` | =1 |

## 3. 文档编号约定

| 前缀 | 范围 | 说明 |
| ---- | ---- | ---- |
| DEV-NNN | 开发指南 | 架构、开发环境、日志、UI 规范等 |
| USER-NNN | 用户手册 | 操作指南、快速入门 |

`adr/` 目录下的 ADR 文档使用独立编号体系（`ADR-NNN-title.md`）。

## 4. 新增文档检查清单

新增公开文档时，请确保：

1. [ ] 文件位于 `docs/i18n/{lang}/` 下对应的子目录
2. [ ] 包含统一 frontmatter：`title`、`category`、`lang` 必填
3. [ ] `sidebar_order` 不与该 category 内现有文档冲突
4. [ ] 仅 GitHub 展示的文档省略 frontmatter，无需 doc site 渲染
5. [ ] 想被 doc site 渲染的文件必须有 frontmatter 且 `category` 在允许值中
6. [ ] `lang` 值必须与所在目录的语言一致
7. [ ] 文件命名符合 `[PREFIX-]NNN-name.md` 格式（如 `DEV-001-system-architecture.md`）

INDEX.md 等纯导航文件不需要特殊设置——LYJ 端自动排除。

## 5. 参考

- `CMTX docs/i18n/zh-Hans/DEV-010-documentation-layout-and-frontmatter.md` — CMTX 原始规范（含完整调研背景）
- `LingYiJu/packages/project/generate-config.ts` — LYJ 端扫描和排除逻辑
