---
title: DEV-038 - Authorization Vocabulary Typology
category: dev-guide
sidebar_order: 38
lang: en
sidebar_group: "Developer Guide"
status: active
created: 2026-11-22
updated: 2026-11-22
description: A four-layer typology of XH authorization vocabulary: 42 action atoms, 3 capability atoms, 11 built-in grant presets and the resource families. Each layer states what it is, where to read it, whether evaluation reads it, and why it is designed that way; ORG_LEADER is marked comment-only with no seed.
tags:
  - authz
  - policy
  - security
  - terminology
---

# DEV-038: Authorization Vocabulary Typology

> Scope: this document answers only "which vocabulary layers authorization has, what each layer is, where to read it, and whether evaluation reads it". The judgement itself, the evaluation chain and scope semantics live in [DEV-037](DEV-037-authorization-model.md); this document does not copy them.
> Vocabulary: the external primary name is **grant preset**; the old term appears once in §4 as a historical name only.
> Source of truth: code under `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/` checked on 2026-11-22; evidence grades follow `fact-verification` ([measured] / [source]).

## 1. The four layers at a glance

| Layer | Current count | Function in judgement | Does evaluation read it? | Source of truth |
|---|---|---|---|---|
| Action atom | 44 | Unit of judgement (`actionClass × resource`) | Yes, intersected per level | `policy/PermissionAtomCatalog.java` |
| Capability atom | 3 | Entry gate (management-plane admission) | Yes, but outside the intersection | `policy/PermissionAtomCatalog.java`, `policy/AuthzContext.java` |
| Grant preset | 11 (8 base + 3 execution presets) | Materialization package (writes atoms into grants) | **No** | `policy/SystemGrantPresetCatalog.java` |
| Resource family | 6 registered namespaces (plus the bare form, see §5) | Second axis (the prefix-matched target) | Yes, for prefix coverage | `policy/ResourceIdentity.java`, `policy/ToolFaceRegistry.java` |

In one sentence: **evaluation reads action atoms, capability atoms (entry gate) and resources; grant presets are materialized into grants rows only at write time.**

## 2. Action atoms (44)

**What it is**: the smallest unit of authorization judgement, in code `PermissionAtom(actionClass, resource)`. The 44 action atoms are a closed set named in `PermissionAtomCatalog.ACTION_ATOM_NAMES`; each atom also carries a `scopeClass`: `instance` means bindable in the instance scope only, `both` means bindable in both the instance and workspace scopes. That class is derived from `INSTANCE_ONLY_ATOMS` (16 atoms); there is no separate `ActionScope` type.

**Where to read**:

- Atom list: `ACTION_ATOM_NAMES` in `policy/PermissionAtomCatalog.java` (44 today, [source]).
- Scope class: `INSTANCE_ONLY_ATOMS` in the same file; anything absent is `both`.
- Canonical resource: `PermissionAtomCatalog.actionResource`; defaults to `*`, credential action classes use `credential:*`.
- Tool-face to action-class mapping: `policy/ToolFaceRegistry.java`.

**Does evaluation read it?** Yes. Every requested `(actionClass, resource)` must match at **every level** of the subject derivation chain; an unknown `actionClass` fails closed.

**Why it is designed this way**: atoms are a **closed judgement set** — enumerable, individually testable, and auditable when a new one is added. If the judgement were free text or a preset name, a new permission could not be reasoned about against existing rules, and golden cases could not pin it. The closed set also separates "tool-face mapping" from "authorization judgement": renaming a tool does not rename an atom, and growing the vocabulary requires an explicit catalog change.

## 3. Capability atoms (3)

**What it is**: `instance:super`, `instance:admin` and `workspace:admin`, three admission markers for platform / workspace management. They answer "is this subject an administrator", not "what may it do to this object".

**Where to read**: `PermissionAtomCatalog.CAPABILITY_ATOM_NAMES`; `policy/AuthzContext.java` resolves the current subject's capability snapshot at authentication time and caches it briefly under `cp.capability-cache-ttl-ms` (default 30000 ms). `instance:super` implies `instance:admin` and `workspace:admin`; `instance:admin` implies `workspace:admin` (`PermissionAtomCatalog.IMPLIES`).

**Does evaluation read it?** Yes, but at the **entry gate**, not in the `(actionClass, resource)` intersection scan. They are **never materialized**: `PresetGrantMaterializer.materializableAtom` returns `null` and skips a capability atom, so it never appears in the `grants` table and cannot be submitted as a grant.

**Why it is designed this way**: capability atoms are an **entry gate**. The management-plane question is "may this subject enter the room", not "may it perform this action on this resource". Treating `instance:admin` as a grantable resource would let administrator authority be assembled from ordinary grants; filtering it out at materialization keeps it derivable only from presets/bindings at authentication time. One collision must be called out: `workspace:admin` is an **atom name**, not a resource namespace; `workspace:` is forbidden as a resource prefix (see [DEV-037](DEV-037-authorization-model.md) §5.1).

## 4. Grant presets (11)

**What it is**: a named set of atoms whose job is to **materialize** atoms into `grants` rows. The external primary name is **grant preset**; the historical `role` / "角色" in older docs and code refers to this layer. Since task-832 the external name is no longer used, and the Java types are `GrantPreset`, `PresetGrantMaterializer` and `SystemGrantPresetCatalog`.

### 4.1 Built-in presets and atom counts

| Preset | Action/capability atoms | Domain | Notes |
|---|---:|---|---|
| `SUPER_ADMIN` | 45 | Instance | All 42 action atoms + 3 capability atoms |
| `ADMIN` | 32 | Instance | User default set + credential management + instance management |
| `USER` | 10 | Instance | Registration default set |
| `WS_OWNER` | 17 | Workspace | Workspace management and editing |
| `WS_EDITOR` | 11 | Workspace | Read/write and workspace configuration |
| `WS_VIEWER` | 2 | Workspace | Read only |
| `AGENT_DELEGATOR` | 1 | Workspace | `SPAWN_AGENT` only; bind explicitly |
| `AGENT_USER` | 6 | Instance | Agent default set (no exec) |
| `AGENT_READER` | 2 | both | Read-only agent preset |
| `AGENT_WORKER` | 3 | both | Read/write agent preset |
| `WS_RUNNER` | 2 | both | Explicit execution preset (exec + workspace runtime) |

The first 8 are the base built-in presets; the last 3 were added by DSD-1500 to pull "execution" out of the default sets. Two counts differ from older cards because DSD-1500 retired exec from defaults: `WS_EDITOR` went from 12 to 11, `AGENT_USER` from 7 to 6 ([source] `SystemGrantPresetCatalog`).

**Where to read**: `presetSeeds()` in `policy/SystemGrantPresetCatalog.java`; Flyway migrations only project the catalog (V88 / V111 / V114 / V127 / V153 / V156 / V157 / V162 / V172 / V178 and so on), and `DefaultSetMigrationParityTest` keeps code and seeds aligned.

**Does evaluation read it?** **No.** The evaluator reads only `grants` rows (the materialized `source='preset'` result) and per-level snapshots; the preset definition itself does not participate in matching. Changing a preset definition does not retroactively change existing grants — it requires re-materialization. Stale snapshots produce "changed but not effective" or "revoked but still allowed".

**Why it is designed this way**: a preset is a **materialization package**, not a judgement dimension. Judgement must be enumerable and testable, so it stays at the atom layer; a preset is just a convenient bundle of commonly used atoms. Making it a judgement dimension has two consequences: changing a preset definition changes all decision semantics, and every new combination needs a new preset. The current shape separates "combination" from "judgement": combinations can be many, while the judgement is always 42 + 3.

`ORG_LEADER` currently exists **only in code comments and migration comments, with no seed row (M2-3)**; it is not a bindable preset and must not be presented as available in UI or docs.

## 5. Resource families

**What it is**: resources are the second axis of judgement, canonically a prefix-matchable "namespace + value" string. There are 6 registered namespaces plus the bare form, seven rows in total:

| Resource family | Shape | May enter grants | How evaluation uses it |
|---|---|---|---|
| File declaration key | `fs:<workspaceId>[/<rel>]` | Yes; the only path shape allowed | Expands to `phys:` for physical identity |
| File physical key | `phys:<normalized absolute path>` | **Never**; API submission is 400 | Only expanded from `fs:` during evaluation |
| Credential | `credential:<uuid>` / `credential:*` | Yes | Credential use requires a concrete uuid |
| Skill | `skill:<uuid>` / `skill:*` | Yes | Skill faces match by prefix |
| MCP server | `mcp:<canonicalServerId>` / `mcp:*` | Yes | A gateway call is evaluated together with the object resource; `*` does not cover `mcp:` |
| Agent unit | `agent-unit:<ltree path>` (`/` segments) | **No** (`EVALUATION_ONLY`) | The spawn judgement appends the caller's own unit subtree; the `tree` matcher covers descendants |
| Bare shape | bare path / URL / `*` | `*` only | Handed to the layered matcher |

**Where to read**: `policy/ResourceNamespaces.java` is the single registry of namespaces, matchers and canonicalizers (created by task-830, extended with `mcp:` by task-870); `policy/ResourceIdentity.java` parses `fs:` / `phys:`; `PermissionAtomCatalog.actionResource` supplies the default `*` and the credential-class `credential:*`. Registration and matcher rules are in [DEV-037](DEV-037-authorization-model.md) §5.1; the `mcp:` channel-gate semantics are in §5.5.

**Does evaluation read it?** Yes, and it is the only second axis. Both `fs:` sides are expanded and compared as physical identity, never falling back to string comparison; `credential:*` is only the wide management-plane shape and cannot replace a concrete uuid for `credential_use`.

**Why it is designed this way**: resources are a **prefix-matchable second axis**. With actions alone, the model cannot say "only this directory subtree". If directories, workspaces and org paths were all stuffed into the resource string, resource identity would drift with context. So only "part of the object's identity" enters the resource string, while workspace and org tree stay in grant scope / visibility scope (see DEV-037). `workspace:` and `session:` are forbidden as resource namespaces — they are context, not objects.

## 6. Why these four layers

| Layer | Design function | What happens if merged into another layer |
|---|---|---|
| Action atom | Closed judgement set | Judgement becomes an open set that cannot be enumerated or tested |
| Capability atom | Entry gate | Admin admission becomes a grantable resource; grants compose into escalation |
| Grant preset | Materialization package | Changing a combination changes judgement semantics; preset explosion |
| Resource | Second axis | Actions alone cannot express object scope |

Each layer owns one question: **atoms decide "what may be done", resources decide "to which object", capability atoms decide "may the subject enter the management plane", and presets decide "which atoms are handed out together"**. The evaluation chain reads only the atoms and resources of the first three layers; presets are the write-time mover.

## 7. How to read this

- Judgement, the nine-step evaluation chain, scope semantics and migration thresholds: [DEV-037 Authorization Model (Intersection-grant)](DEV-037-authorization-model.md).
- Which term to use: [DEV-032 Terminology](../zh-Hans/DEV-032-terminology.md).
- Authorization contract inputs, steps and error codes: `spec/security/authorization.md`.
- This document defines no scope and copies no resource-matching algorithm; when in doubt, DEV-037 and the source code win.
