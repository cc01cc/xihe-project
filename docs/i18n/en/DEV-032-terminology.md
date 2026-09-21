---
title: DEV-032 - Terminology (Polysemy and Synonyms)
category: dev-guide
sidebar_order: 32
lang: en
sidebar_group: "Developer Guide"
status: active
created: 2026-09-16
updated: 2026-09-21
---

# DEV-032: Terminology (Polysemy and Synonyms)

> **Role**: SSOT for wording in XH docs and unstarted PLANs. Two problem classes: (1) **polysemy** → disambiguated canonical names; (2) **synonyms** → one canonical term plus aliases.
> **Scope**: `plans/PLAN-*-XH-*` (drafts first), `A03-xihe/docs/`, prose in project `AGENTS.md`. Completed packages and `review/` history are **not** rewritten unless the file is edited again.
> **Out of scope**: OpenAPI path literals and locked code identifiers (renames need their own PLAN, cf. PLAN-0356).

## 0. Rules

1. Never use a bare ambiguous token from §1 for a non-canonical sense.
2. One concept → one canonical term; aliases may appear once in parentheses.
3. Keep backlog IDs (`M-2`, `M-3`, `CTX-1`, …); pair ID with canonical name on first mention.
4. Chinese jargon pairs with English canonical once (§3).
5. Suggested README line: `> Terminology: DEV-032.`

## 1. Polysemy → distinct canonical names

| Bare token | Sense | **Canonical** | Do not |
|---|---|---|---|
| **owner** | RBAC role on workspace | `workspace role owner` | bare `owner` for lease |
| | Lifecycle execution claimant | **`execution lease holder`** | bare `owner` / unqualified `active owner` |
| **L1/L2/L3** | Context injection slots | **`context L1`** | bare `L1` |
| | Diagnostics layers | **`diagnostic L0/L1/L2`** | bare `L1` |
| | Checkpoint restore layers | **`checkpoint L1`** | bare `L1` |
| **resume** | Session / ChatRun recovery | **`run resume`** | bare `resume` for unpause |
| | Leave workspace `paused` | **`unpause`** | bare `resume` / sole name “recovery consumer” |
| **scope** | Job lifetime boundary | **`job scope`** (`run/session/workspace`) | bare `scope` for the policy layer |
| | Policy / tool-face layer | **`policy scope`** (`instance/workspace/user`; tool faces also `builtin`) | bare `scope` for a Job |
| **interrupted** | Job terminal caused by Runtime restart or unconfirmed start | **`job interrupted`** | blend with run `ambiguous`; call it “recovered/replayed” |
| **runtimeBootId** | Runtime per-process boot id | **`runtimeBootId`** | treat as a business identity |
| **job** | Current background job | **`durable job`** | mix with deleted table |
| | Historical table | **`runtime_jobs` (legacy, deleted)** | treat as live |
| **snapshot** | Current pre-write restore point | **`checkpoint`** | active docs using `snapshot` for restore point |
| | Retired mechanism | **`legacy snapshot`** | blend with checkpoint |
| **收敛 / 收口** | Many paths → one authority | **converge** | use “close” for state-machine merge |
| | Scattered entries → one seam | **route-to-seam** (“收口”) | use “converge” for REST→executor |

## 2. Synonyms → canonical + aliases

### 2.1 Still live (unstarted / in-flight PLANs use canonical)

| Concept | **Canonical** | Aliases | Where |
|---|---|---|---|
| Ensure execution environment ready (contract verb) | **`ensure`** | materialize (prose), provision | 0329/0345; tests use `ensure` |
| HTTP path for async ready | **`materialize` (API path)** | do not rename URL to `ensure` | prose: “trigger ensure (API: materialize)” |
| Merge concurrent ensure per workspace | **`ensure single-flight`** | **M-3** (ID), materialize dedupe | 0345; first mention `M-3 (ensure single-flight)` |
| Drop old tool outputs outside window | **`prune`** | mask, truncation as prune duty | 0341; 20-msg cap = assembly fuse, not prune |
| Rule-based summary + one rerun | **`compaction`** | auto-summary; “shrink” = prune∪compaction | 0341 |
| Code path leaving `paused` | **`unpause activation path`** | recovery consumer, resume consumer | 0345 M-2 |
| Bypass executor, hit host FS | **`executor-bypass`** | raw host FS direct | 0329 |
| Resume long-running job output | **`durable job continuation`** | job resume | 0344 |

### 2.2 Already migrated (active docs: canonical only)

| Concept | **Canonical** | Retired | PLAN |
|---|---|---|---|
| Pre-write restore point | **checkpoint** | `revert_snapshot`, active snapshot restore | 0356 |
| Old snapshot surface | **legacy snapshot** (retirement prose only) | blending with checkpoint | 0357 |

### 2.3 Confusable but **not** synonyms (do not merge)

| A | B |
|---|---|
| Ledger single-writer (0326) | ensure single-flight (M-3) |
| ensure single-flight | chat `409 CHAT_IN_PROGRESS` |
| execution lease holder | workspace role owner |
| run resume | unpause |
| **durable job continuation** | **Workspace `unpause` / `run resume`** — reading existing Job output (`job-output`, read-only cursor) is not reactivating execution |
| **job `interrupted`** | **run `ambiguous`** — Job judged dead by a Runtime restart (never replayed) vs run terminal still undecided |
| converge | route-to-seam |

## 3. Recommended phrasings

- “Runtime **ensures** readiness; CP exposes **materialize**.”
- “**ensure single-flight (M-3)** → one entity creation.”
- “At most one **execution lease holder**; lease dies on destroy.”
- “`paused` requires an **unpause activation path**.”
- “REST file surface is **routed to the executor**; no **executor-bypass**.”
- “**context L1** injection; **diagnostic L1** deferred.”

## 4. Rollout

| Phase | Action |
|---|---|
| 2026-09-16 | Align unstarted XH PLAN README/spec to §1–§3 |
| 2026-09-21 | Add `scope` / `interrupted` / `runtimeBootId`; §2.3 separates **durable job continuation** from Workspace `unpause` / `run resume` (PLAN-0390) |
| Completed / archive / review | No historical rewrite; align when file is edited |
| Code identifiers | Separate PLAN if renamed (cf. 0356) |

## 5. Related

DEV-031 / PLAN-0329 (`ensure`); PLAN-0345 (lease, unpause); PLAN-0341 (prune, compaction); PLAN-0356 (checkpoint); DEV-030 (doc layout); PLAN-0390 + `spec/workspace/execution-job.md` (`job scope` / `interrupted` / `runtimeBootId`).
