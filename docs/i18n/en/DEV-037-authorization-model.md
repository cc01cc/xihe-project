---
title: DEV-037 - Authorization Model (Intersection-grant)
category: dev-guide
sidebar_order: 37
lang: en
sidebar_group: "Developer Guide"
status: active
created: 2026-11-20
updated: 2026-11-22
description: Judgement, rationale and migration thresholds of XH's in-house authorization model. It names the model "Intersection-grant Authorization", explains why it is not a role-based permission system, compares it with nine mature families, and records the nine-step evaluation chain, the cost of building it in-house, and the three engineering mechanisms. It also records the v3 target: five condition operators, approver rights, and the ten-step chain.
tags:
  - authz
  - policy
  - security
---

# DEV-037: Authorization Model (Intersection-grant)

> Naming status: **final (DSD-1499, user ruling 2026-11-20)**. "Intersection-grant Authorization" is the chosen name, not a proposal. A rename touches only three places: this title, the conclusion sentence in §1, and the term entry in `A03-xihe/docs/i18n/zh-Hans/DEV-032-terminology.md`.
> Readers: developers deciding "may this path proceed", reviewers deciding "did the PEP (policy enforcement point) miss anything", and decision-makers deciding "should we replace it with an off-the-shelf engine".
> Source of truth: the judgement follows the code under `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/` (rechecked against the 2026-11-22 working tree). Evidence grades follow `fact-verification`: [measured] / [source] / [doc].
> Decision records: naming DSD-1492, migration thresholds DSD-1497.

**Terminology (applies to the whole document)**

- **grant scope**: the tier a grant binding lives in. The code type is `AccessScope`, with exactly two values: `instance` and `workspace`. It is **not** a matching dimension. It does two things only: it limits which grant rows a decision draws candidates from, and it decides whether an atom may be bound at that tier at write time.
- **visibility scope**: an ltree path in the org tree. The code type is `OrgUnitAccess.Scope`. It belongs to conditions / context and answers "which org units may this subject see"; it does **not** enter the resource axis or the `(actionClass, resource)` pair.
- This document never uses a bare "scope". Every occurrence carries a qualifier: grant scope or visibility scope. Code identifiers (`AccessScope`, `OrgUnitAccess.Scope`, and so on) keep their original names.

## 1. One-sentence conclusion: call it intersection-grant authorization, not a role-based permission system

**Intersection-grant Authorization**: whether a tool call passes depends on whether **(action atom × resource prefix) are both explicitly granted on two axes, and every level of the subject's derivation chain holds that atom**. Default deny. A grant preset is only the channel that materializes atoms into grants; evaluation never reads a grant-preset variable.

An acceptance sentence: *given a principal, actionClass, and resource, the three intersect non-emptily, the resource prefix covers the real target, and every level of the subject derivation chain holds the atom — only then ALLOW; otherwise DENY.*

| Candidate | Claim | Verdict |
|---|---|---|
| **Intersection-grant Authorization** | The name points directly at the invariant: two axes intersect + default deny | **Adopted** (DSD-1499, user ruling 2026-11-20) |
| Capability-boundary Authorization | Emphasizes "every level of the subject chain has a ceiling" | Alternative: states only the ceiling side, not the resource-axis intersection |
| Atom-grant Authorization | Emphasizes that the atom is the unit of judgement | Alternative: easily read as an ABAC "attribute atom" |

Three counterexamples (why it must not be read as a role-based permission system):

| Counterexample | Fact | Anchor |
|---|---|---|
| Changing a grant preset does not change the authorization surface | A grant preset only materializes atoms into `grant_preset_atoms`; the evaluation input is the two-field `PermissionAtom(actionClass, resource)`, and `parse` throws `Unknown permission atom field` on a third key | `policy/PresetGrantMaterializer.java:373-393`; `policy/GrantIntersectionEvaluator.java:36-52`, `:46-50` |
| Capability atoms never enter grants | Platform/instance capability atoms are not grantable actions; materialization returns null and skips them | `policy/PresetGrantMaterializer.java:381-383`; `policy/PermissionAtomCatalog.java:414`, `:419` |
| Composition is not "multi-preset union amplification" | Multiple grants for one subject do union (source labels create no precedence), but after the union the decision still applies resource-prefix coverage and the **write-time** ceiling: a bound cap must not exceed the atom sets held by both the subject and the operator, otherwise 403 `AGENT_PERMISSION_SCOPE_EXCEEDED` | `policy/GrantIntersectionEvaluator.java:152-165`; `service/AgentPrincipalService.java:539-563` |

**Forbidden terms** (never use in writing or review): `RBAC`, `role-based permission system`, `scope intersection`. The last one is wrong because it treats grant scope as a matching axis: grant scope only limits the candidate set and write-time bindability, while the real intersection is `actionClass × resource`. The bare word "scope" is insufficient here; write **grant scope** or **visibility scope**, and treat a bare "scope" as a terminology defect. `RBAC` may appear only in the comparison table and source links (comparison context), never as a description of this model.

## 2. Decision inputs: two judgement axes + per-level holding on the subject chain + grant scope limiting the candidate set

A decision has three parts, but **only two matching dimensions**:

1. **Two judgement axes**: `actionClass × resource`. This is the only matching surface and the thing that truly intersects grant rows with a request.
2. **Per-level holding on the subject chain**: the principal is not a single point. It is the entire derivation chain resolved from the session leaf plus agent bindings. **Every level** must hold that `(actionClass, resource)` atom; any level without it denies.
3. **grant scope limiting the candidate set**: `AccessScope`'s `instance` / `workspace` only decides "which tier of grants to draw candidates from", and at write time decides "may this atom be bound at this tier". It is **not a third matching dimension**. A request body must not carry the grant scope that decides authorization, and it must **not** be stuffed into `PermissionAtom`.

| Input | Source | Must not do | Anchor |
|---|---|---|---|
| **actionClass (axis 1)** | Tool-to-action-class mapping (built-in tools + third-party MCP tools' extraFaces) | The caller does not declare the action class; an unclassified tool falls to `UNCLASSIFIED_ACTION` | `policy/ToolFaceRegistry.java:277-299`; `policy/PolicyRequest.java:24-27` |
| **resource (axis 2)** | Target string parsed from tool arguments (`fs:` declaration key, `phys:` evaluation key, `credential:<uuid>`, `skill:<uuid>`, and so on) | A credential-use request must carry a concrete `credential:<uuid>`; `credential:*` and a bare `*` throw on `credential_use` (fail-closed) | `policy/PolicyRequest.java:28-37`; `policy/ToolFaceRegistry.java:423-445` |
| **principal chain (per-level holding)** | Session-leaf participant + agent bindings; `resolveAgent` returns the leaf principal and the whole session chain | Do not trust a principal supplied by the request; a tenant mismatch, missing principal, or cycle anywhere in the chain is fail-closed | `policy/GrantPrincipalPathResolver.java:78-106` |
| **grant scope (candidate partition)** | `AccessScope`, derived from `workspaceId` / `sessionId`, **not a request parameter** | It does not participate in `(actionClass, resource)` matching; a request body must not carry it; cross-workspace reads/writes are decided by the repository's scoped queries | `spec/security/authorization.md` §2 step 2; `service/AgentPrincipalService.java:536-540` |

**One-sentence acceptance rule**: ALLOW only when the `actionClass × resource` axes both match, every level of the subject chain holds the atom, and the candidate rows fall inside the tier allowed by the current grant scope; default deny. grant scope provides **partitioning** and **write-time bindability**, not a third axis.

### 2.1 Context: a third input, not a third axis

Workspace, org unit, and session are **context**. They answer "where does this request happen" and never participate in `(actionClass, resource)` matching. They decide three things only:

- **instance / workspace** is expressed by grant scope (item 3 above) and selects which grant tier to read;
- **org unit** is expressed by visibility scope (`OrgUnitAccess.Scope`, see §5.4) and decides which data is visible;
- **session** is a container identity that carries the subject chain and its snapshots.

Context **MAY** be read by conditions (§4.1), but **MUST NOT** become a third matching axis. The cost of pushing the org unit onto the resource axis is in §5.4.

## 3. The nine-step evaluation chain

<svg viewBox="0 0 660 400" width="100%" role="img">
  <title>DEV-037: nine gates a tool call passes through</title>
  <defs><marker id="ar37" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#4f46e5"/></marker></defs>
  <rect x="16" y="26" width="336" height="360" rx="6" fill="#f9fafb" stroke="#d1d5db"/>
  <text x="32" y="46" font-size="12" fill="#374151">Request enters</text>
  <rect x="32" y="56" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="72" font-size="11" fill="#374151">1 auth + tv</text><text x="248" y="72" font-size="11" fill="#6b7280">auth filter</text>
  <rect x="32" y="92" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="108" font-size="11" fill="#374151">2 grant scope</text><text x="248" y="108" font-size="11" fill="#6b7280">CP resolves</text>
  <rect x="32" y="128" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="144" font-size="11" fill="#374151">3 capability atom</text><text x="248" y="144" font-size="11" fill="#6b7280">AuthzContext</text>
  <rect x="32" y="164" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="180" font-size="11" fill="#374151">4 tool face mapping</text><text x="248" y="180" font-size="11" fill="#6b7280">ToolFace</text>
  <rect x="32" y="200" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="216" font-size="11" fill="#374151">5 L0 hard guard</text><text x="248" y="216" font-size="11" fill="#6b7280">HardGuard</text>
  <rect x="32" y="236" width="200" height="24" rx="4" fill="#ffffff" stroke="#4f46e5"/><text x="44" y="252" font-size="11" fill="#312e81">6 atoms + resource</text><text x="248" y="252" font-size="11" fill="#4f46e5">GrantAuthz</text>
  <rect x="32" y="272" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="288" font-size="11" fill="#374151">7 approval gate</text><text x="248" y="288" font-size="11" fill="#6b7280">Approval</text>
  <rect x="32" y="308" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="324" font-size="11" fill="#374151">8 execution</text><text x="248" y="324" font-size="11" fill="#6b7280">Runtime</text>
  <rect x="32" y="344" width="200" height="24" rx="4" fill="#ffffff" stroke="#9ca3af"/><text x="44" y="360" font-size="11" fill="#374151">9 audit</text><text x="248" y="360" font-size="11" fill="#6b7280">AuditLogger</text>
  <path d="M400,60 L400,356" stroke="#4f46e5" stroke-width="1.5" marker-end="url(#ar37)"/>
  <text x="416" y="200" font-size="11" fill="#4f46e5">narrower downward</text>
  <text x="416" y="220" font-size="10" fill="#9ca3af">default deny</text>
</svg>

| # | Step | Who decides | Anchor | Failure mode |
|---|---|---|---|---|
| 1 | Authentication + access-token epoch | Auth filter chain (a token `tv` that differs from `users.token_version` is 401) | `auth/AuthService.java:196-200`; `spec/security/authorization.md` §6 | An old token keeps working; revocation is ineffective |
| 2 | grant scope derivation (tenant consistency + candidate partition) | CP derives it, not a request parameter | `policy/GrantAuthorizationService.java:83-102` | Cross-tenant reads/writes; candidates drawn from the wrong tier |
| 3 | Capability-atom gate | Capability cache `AuthzContext` (`cp.capability-cache-ttl-ms`, default 30000 ms) | `policy/AuthzContext.java:106` | Unauthorized entry into the management surface |
| 4 | Tool face to action class | `ToolFaceRegistry` constructor | `policy/ToolFaceRegistry.java:277-299` | Tool misclassification; the wrong axis is applied |
| 5 | L0 hard guard | `HardGuard` (builtin layer, before any grant) | `policy/HardGuard.java:59`, `:98-112`; `policy/PolicyEngine.java:111-112` | An irreversible delete on a critical path is allowed |
| 6 | Atoms and resources (candidates on the subject chain) | `GrantAuthorizationService.allows` loads sources and snapshots → `GrantIntersectionEvaluator.allows` decides | `policy/GrantAuthorizationService.java:83-123`; `policy/GrantIntersectionEvaluator.java:211-240` | Unauthorized execution |
| 7 | Approval gate (ASK or not) | `PolicyEngine.approvalVerdict`, by the ask action-class list | `policy/PolicyEngine.java:198-213` | A required question is skipped, or everything becomes noise |
| 8 | Execution | Runtime (`job_host_adapter.rs` explicitly does no sandbox and no policy) | `packages/runtime/src/job_host_adapter.rs:1-5` | Assuming Runtime is a backstop when there is none |
| 9 | Audit | The approval chain writes `audit_logs`; authorization evaluation itself only logs WARN | `policy/GrantAuthorizationService.java:119-121` | A denial cannot be explained |

This section is the **current** chain. The v3 target inserts "condition" between steps 6 and 7 and changes how the approval gate decides who may approve; the full ten-step chain is in §4.3.

## 4. The judgement itself (source anchors)

| Judgement | Content | Anchor |
|---|---|---|
| Two atom fields | `PermissionAtom(actionClass, resource)`; an unknown field throws, and no third dimension may be smuggled in (grant scope is not inside the atom) | `policy/GrantIntersectionEvaluator.java:36-52`, `:46-50` |
| Default deny | Empty subject chain, empty action class, blank resource, or an action class outside the closed set is always false | `policy/GrantIntersectionEvaluator.java:265-309` |
| Both axes match | Decide each `(actionClass × resource)` pair; any pair without a match is false | `policy/GrantIntersectionEvaluator.java:326-362` |
| Resource matching | When both sides are `fs:` declaration keys, expand to `phys:` and compare physical identity (never string equality); otherwise use the layered matcher | `policy/ResourceIdentity.java:104-130`; `policy/GrantIntersectionEvaluator.java:202-208` |
| Closed source set | Grants participating in a decision come from the closed `EVALUATION_SOURCES` (6 sources); source labels create no precedence | `policy/GrantSources.java:59-63`; `policy/GrantIntersectionEvaluator.java:152-165` |
| Write-time ceiling | A bound cap must be ⊆ atoms held by the subject and ⊆ atoms held by the operator, otherwise 403 naming the exceeding atom | `service/AgentPrincipalService.java:539-563` |

**One implementation detail that must be stated**: the javadoc of `GrantIntersectionEvaluator.allows` (`:97`, "Every requested atom must be granted by every principal in the operation path.") matches the implementation. **Every level** of `principalPath` must hold that `(actionClass × resource)` atom; any level whose `noneMatch` is true makes the whole call `return false` (`:103-120`). Intersection-on-the-path therefore holds **at evaluation time**, not only at write time. Review reading: `path` is resolved by `policy/GrantPrincipalPathResolver` along the subject derivation chain (`:78-106` validates each agent level), and a missing atom anywhere on the chain denies the whole call; loosening one level alone has no effect. There is also a write-time **pre-ceiling** (cap ⊆ subject-held atoms and ⊆ operator-held atoms, `service/AgentPrincipalService.java:539-563`, otherwise 403 `AGENT_PERMISSION_SCOPE_EXCEEDED`): it is a pre-persistence boundary check and cannot replace the read-time decision.

### 4.1 Conditions: extra limits outside the grant

A condition is a second check stored in the policy layer, separate from grants. It reads fields from the request context and **can only narrow, never widen**: it never grants permission and never participates in `(actionClass, resource)` matching.

| Operator | Example |
|---|---|
| equals `eq` | the request's project must be `p-42` |
| not equals `neq` | requests from sandbox are not allowed |
| in `in` | the request's environment must be in the `prod` / `staging` set |
| exists `exists` | the request must carry a `trace_id` |
| time window `before`–`after` | only allowed between 09:00 and 18:00 |

Hard rules:

- The operator set **MUST** stay closed to these five; custom operators or expression languages are **MUST NOT**.
- A **missing field** in the request context counts as unsatisfied; an **unregistered condition key** denies outright. **MUST NOT** ignore unknown keys or treat them as passing.
- Changing a condition **MUST NOT** require re-issuing grants: conditions and grants are two separate stores.
- Endpoint-level visibility checks (the org tree's "non-members see 404") **MUST NOT** be called conditions; they are visibility guards. `in_subtree` is therefore not part of the operator set.

Cross-reference: `spec/security/authorization.md` §2.2; the "conditions" card in the authorization figure.

### 4.2 Approval: a risk modality, not a permission

Approval grants no permission; it only decides whether this call must wait for a nod. It does not sit on the same lattice as ALLOW / DENY, and the merge rule is fixed: **deny wins, then confirmation**:

- any denial → `DENY`
- no denial but approval needed → `ASK`
- everything passes → `ALLOW`

Who may approve (v3 target, **not implemented**):

- Who can approve: `(action:approve, this request's resource)` both match; the approver may be a human account or an Agent holding that atom.
- Who cannot: the requester itself, or anything upstream or downstream of it.
- How long: valid for this one request only; timeout or rejection both count as deny.

Status: ASK currently matches by action class only (`policy/PolicyEngine.java:187-200`, the `askActionClasses[]` list) and ignores the resource; the addressee is hard-coded to the run owner (`chat/UserQuestionService.java:209-212`, non-owners get a uniform 404 at `:305`), and grants are never read. Both are hidden predicates and **MUST** converge onto permission decisions. `action:approve` is currently **not** among the 42 built-in action atoms and must be added.

Request identity, state machine, reuse levels, and restart reconciliation live in `spec/security/approval.md`; this section does not repeat them.

### 4.3 The v3 target ten-step chain (proposed)

Only two things differ from §3: step 7 adds "condition", and step 8 "approval" changes its predicate. Everything else restates the same stage. **MUST NOT** be cited as implemented fact.

| # | Step | Predicate | Status |
|---|---|---|---|
| 1 | Is the login still valid | signature + epoch `tv` (§3 step 1) | implemented |
| 2 | Where does this request happen | grant scope derived server-side (§3 step 2, §2 item 3) | implemented |
| 3 | Is this a management surface | capability atoms judge the current identity only, no per-level intersection (§3 step 3) | implemented |
| 4 | What is done, to what | tool-face mapping + resource string parsing (§3 step 4) | implemented |
| 5 | Hard guard | L0 hard guard, ahead of all grants (§3 step 5) | implemented |
| 6 | Both axes match | the only matching point; every level on the chain must hold (§3 step 6) | implemented |
| 7 | Condition | §4.1, five operators, narrow only | **not implemented** |
| 8 | Approval | §4.2, approver right via `(action:approve, resource)` | **partial**: action class only; approver hard-coded |
| 9 | Execution | Runtime no longer judges permissions (§3 step 8) | implemented |
| 10 | Record | denial reasons explainable (§3 step 9, §10) | partial: evaluation failures still only WARN |

- Step 6 is the only matching point; steps 3, 5, 7, and 8 only add gates, conditions, or confirmations and **MUST NOT** turn a denied call back into an allowed one.

## 5. Resources and the atom catalog

- Atom catalog: **42 action atoms + 3 capability atoms** (`policy/PermissionAtomCatalog.java`; the [measured] enumeration count is in `internal/A03-xihe/evidence/2026-11-20-permission-atom-matrix/README.md`).
- Action classes with a tool-face entry: **7** — `read`, `write`, `exec`, `network`, `credential_use`, `spawn_agent`, `team_task_manage` (`policy/ToolFaceRegistry.java:280-296`). The `delete` action class exists, but no tool maps to it today and `WRITE_TOOLS` contains no delete tool (`policy/ToolFaceRegistry.java:193-195`, `:254`), so that atom is unreachable through the tool chain.
- Resource families (the value shapes on the resource axis): `fs:` declaration keys (**the only path form that may be written to a grant**), `phys:` evaluation keys (expanded only at evaluation time), `credential:` (`credential:*` or `credential:<uuid>`), `skill:` (`skill:*` or `skill:<uuid>`), plus bare paths / URLs / `*`. The prefix constants for `credential:` and `skill:` are at `policy/ToolFaceRegistry.java:168-169` and `:176`; `fs:` / `phys:` are at `policy/ResourceIdentity.java:24-25`.

Default action-atom counts for the eight built-in grant presets ([measured], same evidence):

| Grant preset | Default action atoms | Category | Definition |
|---|---|---|---|
| SUPER_ADMIN | 45 | Platform | `policy/SystemGrantPresetCatalog.java` |
| ADMIN | 32 | Platform | Same |
| USER | 10 | Platform | Same |
| WS_OWNER | 17 | Workspace | Same |
| WS_EDITOR | 12 | Workspace | Same |
| WS_VIEWER | 2 | Workspace | Same |
| AGENT_DELEGATOR | 1 | Agent | `policy/SystemGrantPresetCatalog.java:374` |
| AGENT_USER | 7 | Agent | `policy/SystemGrantPresetCatalog.java:385` |

- `ORG_LEADER` currently exists **only in code comments and the governance whitelist description; no seed has been written (M2-3)**. Do not present it as an available grant preset or a bindable item in UI or documentation.

PEP coverage: only 7 of the 42 atoms (about 17%) have a tool-face entry; the Windows host channel has neither sandbox nor policy gate (`packages/runtime/src/job_host_adapter.rs:1-5`). The coverage list and gaps are in `internal/A03-xihe/evidence/2026-11-20-pep-coverage/README.md`.

### 5.1 Resource namespaces and name collisions

A resource string has the canonical shape "namespace + value": `fs:<workspaceId>[/<rel>]`, `credential:<uuid>`, `skill:<uuid>`, and so on. The namespace registry (the single registration point delivered by task-830) is the source of truth: **an unregistered prefix in a grant resource must fail closed**; "it looks like a prefix" is not enough. The registry also declares matcher types (`exact` / `prefix` / `tree`); only `exact` and `prefix` are active today, and `tree` is a reserved type with no `org:` namespace registered (see §5.4).

**Two name collisions must be kept apart**:

- The capability atom `workspace:admin` (`policy/PermissionAtomCatalog.java:62`) is an **atom name**. It answers "is this subject a workspace administrator", not a resource string. The resource namespace **must not** use `workspace:`: a workspace is context (expressed by grant scope), not object identity. Putting it into a resource string would split one object into two identities across workspaces.
- The action atom `session:permission:configure` is likewise an **atom name**, not a resource namespace. `session:` is explicitly forbidden as a resource key: a session is a context container, not a grantable object. Putting a session on the resource axis would make the judgement depend on "which session" rather than "which object".

Once the registry lands, `workspace:` / `session:` as resource prefixes should be rejected outright. When you see them in a document, first check whether the text means an atom name or a resource string.

### 5.2 fs / phys dual track: grants write declaration keys, physical keys exist only at evaluation time

| Track | Shape | May enter grants? | May be submitted through the API? | Purpose |
|---|---|---|---|---|
| Declaration key | `fs:<workspaceId>[/<rel>]` | **Yes, and this is the only form** | Yes | Auditable and stable across machines; a moved workspace still points at the same logical path |
| Physical key | `phys:<normalized absolute path>` | **Never** | **Never**; submitting it returns 400 `INVALID_GRANT_RESOURCE` | Expanded from a declaration key only at evaluation time, to compare whether two declaration keys point at the same physical identity |

Rationale: `phys:` is a host absolute path. It changes when the machine, container, or restored backup changes. Writing it into a grant would pin the permission to one machine, while a grant is a long-lived authorization and must not drift with deployment. The write face `policy/GrantResourcePattern.java` accepts only `*`, `credential:*` / `credential:<uuid>`, and `fs:` declaration keys; every other shape is 400. The evaluation face `policy/ResourceIdentity.java:104-130` expands two `fs:` sides to `phys:` and compares, and **never** falls back to string comparison.

Two acceptance criteria (pinned by task-830 tests, not reimplemented here): (1) submitting a `phys:` grant must return 400; (2) the same `fs:` declaration key must still hit the same grant after expansion under two different host roots.

### 5.3 `credential:*` is for the management surface only

`credential:*` is the canonical resource of the credential **management** surface (the default wide grant of atoms such as `credential_manage`). It is **not** an authorization reading of "may use every credential". A credential-use decision must carry a concrete `credential:<uuid>`; a **decision request** whose resource is `credential:*` with actionClass `credential_use` must be rejected. The code boundary is `policy/ToolFaceRegistry.java:423-445`: `isCanonicalCredentialResource` accepts only `credential:*` and a canonical lowercase UUID, and `isConcreteCredentialResource` excludes the wildcard. Request parsing `policy/PolicyRequest.java:28-37` requires a concrete UUID for credential requests and throws on `credential:*` and a bare `*`. A wide grant row is still a ceiling spelling; it does not let a request skip the concrete uuid.

The distinction is "which credentials may be managed" versus "which single credential may be used". The former may be wide; the latter must name one object, otherwise a single grant hands over use of every credential.

### 5.4 The org tree stays in conditions, not on the resource axis

The org tree is **visibility scope** (`OrgUnitAccess.Scope`, an ltree path) and permanently stays in conditions / context: it answers "which org units may be seen", not "which object may receive which action". Putting it on the resource axis would break two things at once: 404 semantics (a non-member must be told "does not exist", not "not permitted") and query-scope semantics (the read face filters by ltree `<@`, rather than doing per-row resource-prefix matching).

The resource registry **reserves a `tree` matcher type**, but does not register an `org:` namespace today. If org units ever need to become resources, add one registry row (namespace + `tree` matcher + canonicalizer); no table change, no parser change, no evaluator change.

### 5.5 Playbook for adding a resource category

To add a resource category such as memory or plugin later, follow this order; skipping a step means it is not done:

1. **Add one registry row**: namespace + matcher (`exact` / `prefix` / `tree`) + canonicalizer.
2. **Add one extractor key**: parsing tool arguments into a resource string happens in exactly one place.
3. **Make the validator accept the prefix**: the write face allows only registered namespaces and fails closed on unknown prefixes.
4. **Add unit / golden cases**: at least "a legal shape matches", "an unknown prefix is rejected", and "stable across machines / hosts".
5. **Add one documentation line**: register it in the resource-family list in §5.

**Do not change the table, the evaluator, or add a migration.** The real cost is not code; it is defining the canonical shape: what counts as "the same memory / the same plugin resource". Get that wrong and no amount of later tests will save it.

## 6. Comparison with mature models

| Family (representative) | Judgement shape | Composition | Resource identity | Default | Explicit deny | Conditions | Explainability | Deployment cost | Migration cost | Coupling to this repo |
|---|---|---|---|---|---|---|---|---|---|---|
| AWS IAM policy family [doc] | Allow/Deny statements on Action × Resource | Multi-policy union; SCP narrows as a boundary | ARN (hierarchical prefix) | Deny | Yes, deny wins | Yes (Condition) | Medium (policy simulator) | Cloud-managed | High (cloud-bound) | High |
| Cloud IAM and SCP (GCP IAM style) [doc] | Roles bound to resource-tree nodes | Union down the resource tree; separate deny policies | `projects/...` resource names | Deny | Yes (deny policy) | Yes (condition expressions) | Medium | Cloud-managed | High | High |
| Kubernetes RBAC [doc] | Role / ClusterRole rules (verbs × resources) | Multi-binding union, add-only | Resource type + name, **no path prefix** | Deny | No | No | Low (`kubectl auth can-i`) | Self-hosted | Medium | Low |
| GitHub fine-grained PAT [doc] | Repository × permission set (read/write) | Union | Repository + permission name | Deny | No | No | Low | SaaS | High | Medium |
| Zanzibar family (OpenFGA / SpiceDB) [doc] | Relation tuples + userset rewrite, `check` walks the graph | Graph evaluation (union / intersection / exclusion expressions) | relation + object id | Deny | Only indirectly through exclusion | Weak (no attributes) | Low (queryable graph) | New service + new database | High (build the graph) | High |
| Cedar / AVP [doc] | `permit` / `forbid` policies + entity attributes | forbid overrides permit; no cross-layer intersection primitive | Entity attributes | Deny | Yes (forbid) | Yes (attributes / context) | High (formal analysis) | Embeddable engine, managed AVP | High | High |
| OPA / Rego [doc] | Arbitrary Rego decision function | Defined by the policy author | Arbitrary | Policy-defined | Policy-defined | Yes (data documents) | Medium (`explain`) | Sidecar or service | High (dual-write consistency) | Medium |
| Casbin [doc] | Model matcher + policy rows | Multi-policy union | Model-defined | Model-defined | Only indirectly through the matcher | Weak | Low | In-process library | Medium | Low |
| **This model (intersection-grant)** | `PermissionAtom(actionClass, resource)` + resource-prefix coverage | Multi-source union for one subject + **write-time ceiling narrowing** + default deny at evaluation | `fs:` declaration keys (expanded to `phys:` at evaluation); `credential:<uuid>`; `skill:<uuid>` | Deny | **No explicit deny** | No (pure atoms, no attributes) | Low (WARN logs only; explain is being built) | Pure in-repo, zero external components | — | — |

Two conclusions:

- The closest match to AWS IAM is three things: **Action × Resource two axes**, **default deny**, and a **boundary ceiling** (SCP to IAM corresponds to this model's write-time ceiling to grants). The biggest difference is that this model has no explicit deny.
- The furthest is the Zanzibar family: this model has no relation graph and no userset rewriting; the judgement is "atom + prefix", not "relation". Any requirement that needs authorization-graph reasoning (sharing, transitivity along a delegation chain) can only be laid out here as explicit grant rows; if that cannot be done, it is time to change families (see §9).

Sources ([doc] grade, official documentation):

- AWS IAM policy elements and SCP boundary semantics: <https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies.html>
- GCP IAM allow and deny policies: <https://cloud.google.com/iam/docs/deny-overview>
- Kubernetes RBAC: <https://kubernetes.io/docs/reference/access-authn-authz/rbac/>
- GitHub fine-grained PAT permissions: <https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens>
- OpenFGA relation model: <https://openfga.dev/docs/concepts>; SpiceDB: <https://authzed.com/docs>
- Cedar language and AVP: <https://docs.cedarpolicy.com/>
- OPA decision model and `explain`: <https://www.openpolicyagent.org/docs/latest/>
- Casbin model syntax: <https://casbin.org/docs/overview>

## 7. Why not use an off-the-shelf component

| Component | What it offers | Why not | Hard conflict |
|---|---|---|---|
| Amazon Verified Permissions (AVP) | Cedar engine + managed policy store + analyzer | Decisions go over the network and bind to an account and quotas | The deployment target is single-machine and offline-first; decisions must not depend on an external service |
| Cedar library (embedded) | Formal semantics, `forbid` override, analyzable | The semantic primitives are permit / forbid and have no "per-level ceiling" dimension; expressing this model's narrowing would require translating every level's ceiling into a forbid set, and the policy count would explode with level combinations | Would require rewriting the whole judgement language and the 42-atom mapping inside CP, and copying the existing semantics is forbidden |
| OPA / Rego | General policy language and `explain` decision chains | Requires a sidecar or a separate service, so judgement and business data cross a process boundary → dual-write consistency cost | No sidecar convention, and decisions must be queryable in the same database and transaction as grants |
| Casbin | Embedded library, configurable model, quick start | The matcher semantics have no resource-prefix tree and no ceiling; the permission set is effectively "role union" | Directory-subtree resource prefixes are a hard requirement |
| OpenFGA / SpiceDB | Relation-graph evaluation, horizontally scalable | The relation model does not express "path prefix"; introduces a new service and database | Single-machine deployment boundary + graph migration cost |

Counterfactual (what happens if the requirement is pushed back into a role model): "let an agent have write only on the `/w/<id>/src` subtree" leaves two paths in a pure role model — promote "path prefix" into a permission type (permission entries grow with the number of directories, and every new directory needs a grant), or build roles for "workspace × directory × action × tier" (combinatorial explosion, and revocation edits the role definition instead of one grant row). This model compresses both into one pair `(atom, resource prefix)`; revocation = delete or edit one grant row.

<svg viewBox="0 0 660 320" width="100%" role="img">
  <title>DEV-037: union grows wider, intersection grows narrower</title>
  <rect x="16" y="24" width="306" height="122" rx="6" fill="#f9fafb" stroke="#d1d5db"/>
  <text x="32" y="44" font-size="12" fill="#374151">Multi-role union</text>
  <rect x="40" y="58" width="70" height="18" fill="#ffffff" stroke="#9ca3af"/>
  <rect x="40" y="82" width="130" height="18" fill="#ffffff" stroke="#9ca3af"/>
  <rect x="40" y="106" width="200" height="18" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="252" y="120" font-size="10" fill="#4f46e5">wider</text>
  <rect x="338" y="24" width="306" height="122" rx="6" fill="#f9fafb" stroke="#d1d5db"/>
  <text x="354" y="44" font-size="12" fill="#374151">Atoms and resources</text>
  <rect x="362" y="58" width="200" height="18" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="362" y="82" width="130" height="18" fill="#ffffff" stroke="#9ca3af"/>
  <rect x="362" y="106" width="70" height="18" fill="#ffffff" stroke="#9ca3af"/>
  <text x="574" y="120" font-size="10" fill="#4f46e5">narrower</text>
  <rect x="16" y="158" width="628" height="146" rx="6" fill="#f9fafb" stroke="#d1d5db"/>
  <text x="32" y="178" font-size="12" fill="#374151">How many roles a pure role model needs for a prefix</text>
  <rect x="40" y="196" width="120" height="26" rx="4" fill="#ffffff" stroke="#9ca3af"/>
  <text x="100" y="214" font-size="11" fill="#374151" text-anchor="middle">workspace</text>
  <text x="172" y="214" font-size="12" fill="#6b7280">x</text>
  <rect x="186" y="196" width="120" height="26" rx="4" fill="#ffffff" stroke="#9ca3af"/>
  <text x="246" y="214" font-size="11" fill="#374151" text-anchor="middle">directory</text>
  <text x="318" y="214" font-size="12" fill="#6b7280">x</text>
  <rect x="332" y="196" width="120" height="26" rx="4" fill="#ffffff" stroke="#9ca3af"/>
  <text x="392" y="214" font-size="11" fill="#374151" text-anchor="middle">action</text>
  <text x="468" y="214" font-size="11" fill="#4f46e5">combinatorial explosion</text>
  <text x="40" y="252" font-size="11" fill="#374151">Revocation = edit the role definition</text>
  <text x="40" y="276" font-size="11" fill="#4f46e5">One grant row does it</text>
</svg>

## 8. The cost and the advantages of building it in-house

| Pitfall | Consequence | Status (2026-11-20) |
|---|---|---|
| 1 Judgement lives in the evaluator, not in grant presets | A reviewer who assumes "editing a grant-preset definition = changing the authorization surface" will miss the two things that really decide an allow: materialized `grants` rows with `source='preset'`, and each level's snapshot on the subject derivation chain. Editing `grants` by hand around `PresetGrantMaterializer`, or changing a grant preset without catching snapshots up, produces "the preset changed but the authorization surface did not" | By design: grant-preset/binding edits go through `/api/v1/presets`, `/bindings`, and the materializer; snapshot catch-up is pitfall 4 |
| 2 No explicit deny | Cannot write an absolute "never allow"; today only HardGuard's hard-coded rules cover critical paths | By design |
| 3 A denial cannot explain itself | A failed decision only logs WARN (`policy/GrantAuthorizationService.java:119-121`); there is no decision chain saying "which level lacks which atom" | explain is being built (task-110) |
| 4 Three snapshots drift | `grants` rows, a binding's `permissionsSnapshot`, and a session's `agentPermissionsSnapshot` are three copies; changing a grant without catching snapshots up produces "changed but ineffective" or "revoked but still allowed" | Untouched |
| 5 Revocation is delayed | Capability atoms use the `cp.capability-cache-ttl-ms` short TTL cache (default 30000 ms); revocation takes effect at worst 30 s late | By design (configurable) |
| 6 Incomplete PEP coverage | Only 7 of 42 atoms have a tool-face entry; the `delete` atom is unreachable through the tool chain; the Windows host channel has neither sandbox nor policy gate | Evidence recorded (`internal/A03-xihe/evidence/2026-11-20-pep-coverage/README.md`); the fix is not ruled |
| 7 Path-prefix boundary semantics | Grants write only `fs:` declaration keys; evaluation expands them to `phys:` physical identity (never string equality); `phys:` never enters grants and is never accepted by the API; `*` still goes through the layered matcher — one mistake is a boundary escape | By design |
| 8 Delegation can escalate | Widening a session tier needs "holds `session:permission:configure` + is the session creator"; narrowing is open to any participant | Implemented (`policy/SessionPermissionGuard.java:20-34`) |
| 9 Atom-catalog growth | Atom names and action classes keep evolving (this repo has grown from a dozen to 42); adding an atom has no mandatory process | Untouched |
| 10 No model-analysis toolchain | No Cedar-analyzer-like "prove there is no hole"; only golden cases and human review | Golden design is being built (task-110) |

Advantages (the positive reasons for the in-house choice, each checkable):

- **Narrow, mechanically checkable judgement surface**: a decision's input is the `(principal, actionClass, resource)` triple, easy to cover with a golden baseline.
- **Zero extra infrastructure**: no sidecar, no policy-distribution service; the decision and grants live in the same database and transaction boundary.
- **Runs offline**: no external call in a decision; unit tests can cover the whole judgement surface without standing up a policy service first.
- **Revocation at the source**: the `tv` epoch, grant-preset materialization, and the three snapshots all live in CP; revocation does not depend on a downstream propagation window.
- **Freedom to evolve**: adding an action atom only touches `PermissionAtomCatalog` and the classification rules; no policy-language migration and no engine-version change.

## 9. Migration thresholds and the three mechanisms

| Trigger | Threshold | Migration action |
|---|---|---|
| Grant rows | More than 2000 rows | Add explain and golden first, then evaluate an external engine |
| Grant-preset count | More than 50 grant presets | Same |
| Need a model-level proof | Any "no hole" claim must be formally proven | Introduce an engine such as Cedar / AVP |
| A second non-tenant dimension appears | For example a time window or an approval-flow policy dimension | Rename the model (it is no longer a two-axis intersection) and re-evaluate the thresholds |

| Mechanism | Purpose | Status (2026-11-20) |
|---|---|---|
| explain (decision-chain explanation) | State "which level matched, which level lacks which atom" | **Landed (task-125 / DSD-1497 mechanism 1, 2026-11-20)**: `POST /api/v1/authorization/explain`, sharing one kernel with the judgement; criteria in §10 |
| golden (judgement regression baseline) | A fixed triple-to-ALLOW/DENY case set | **Landed (task-110 / DSD-1497)**: `packages/control-plane/src/test/java/com/cc01cc/p/xihe/cp/policy/authz-golden-baseline.json`, 59 lines (30 allow / 29 deny); `AuthzGoldenBaselineTest` decides each line; since task-125 explain recomputes the same 59 lines |
| PEP inventory | Which tool faces and channels are actually wired to the judgement | Evidence produced (`internal/A03-xihe/evidence/2026-11-20-pep-coverage/README.md`) |

## 10. Explainability: the explain surface (DSD-1497 mechanism 1, task-125)

"Why was this denied" is not answered by guessing from logs. A read-only endpoint answers it directly: `POST /api/v1/authorization/explain`, request `{actionClass, resource, sessionId?}`, response `{allowed, deepestMissingLevel, missingAtom, missingLevels[], matchedGrantRefs[], evaluatedLevels[]}`.

### 10.1 One judgement, two faces

explain is not a second judgement. `GrantIntersectionEvaluator` has exactly one `decide(request, levels, record)`:

- Authorization calls `allows(...)` ≡ `decide(..., record=false).allowed()`;
- explain calls `explain(...)` ≡ `decide(..., record=true)` (the same guards, the same `matchesResource`, the same intersection scan; it simply records the matched rows and missing levels along the way).

Why change the kernel for this instead of recomputing in the controller: recomputing is a second judgement, and when the two diverge, "explain says allow, the real call is denied" becomes a bug that can never be resolved. The anti-divergence evidence is `ExplainMatchesGoldenBaselineTest`: it feeds all 49 gate=intersection lines of the baseline to both `allows` and `explain`, asserts the two conclusions match line by line, and requires allow lines to have `deepestMissingLevel = -1`, `missingAtom = null`, and a non-empty `matchedGrantRefs`.

### 10.2 How to read the fields

| Field | Meaning | Reading note |
|---|---|---|
| `allowed` | The same boolean as the real allow | A denial is still HTTP 200 (the endpoint answered the question; the endpoint did not fail) |
| `deepestMissingLevel` | The largest index among missing levels; `-1` = allowed | Also used for "denied before evaluation" (see `missingAtom.reason`) |
| `missingAtom` | The deepest missing item (null when allowed) | Carries `reason`: `level-without-grants` (that level has no grants at all) and `no-matching-atom` (it has grants but none cover) are different, and that difference is the actionable half |
| `missingLevels[]` | All missing levels | When several levels are missing, you do not get only the deepest one |
| `matchedGrantRefs[]` | The rows that actually granted | Each carries `grantId` and `grantSource` (role / template, etc.) for traceability |
| `evaluatedLevels[]` | Every level scanned | Carries `atomCount` and `matched`, so `atomCount=0` and "has atoms but none match" are distinguishable |

`reason` vocabulary: `empty-request` / `empty-principal-path` / `no-subject` / `unknown-action-class` / `blank-resource` are pre-evaluation denials; `level-without-grants` / `no-matching-atom` are in-level denials.

### 10.3 Capability atoms are not on the explain surface

`actionClass` accepts only the action-class vocabulary (`ToolFaceRegistry.builtinActionClasses()`). Passing a capability atom as `actionClass` (for example `instance:admin`) is denied before any level is scanned, returning `allowed=false` + `reason=unknown-action-class` + `deepestMissingLevel=-1`. This is deliberate: capability atoms are not evaluated in the intersection, and explain would be inventing an answer if it pretended to explain them.

### 10.4 Exposure boundary

- **The subject is not selectable**: the subject comes from `TenantContext`'s current user, not a request field, so it is structurally impossible to explain someone else. The response can contain only grant rows on the caller's own path (id + source), never other people's grants, member lists, or resource details.
- **Writes nothing**: no row, no cache (DSD-1497 M2-10a forbids evaluation-side caching), and the response body does not enter audit details (audit keeps only the requestId).
- **grant scope**: `sessionId` is optional and places the request in that session's workspace context; it must be readable by the caller (otherwise 404 `SESSION_NOT_FOUND`, the same non-distinguishing 404 as other session-read faces, with no existence probe). Without it, the current workspace context is used.
- **Tenant gate**: the surface itself is non-GET, but the write-gate classifier does not treat `/api/v1/authorization/**` as a workspace-write surface, so any grant preset with a resolved workspace membership passes; a caller with no workspace context is stopped by the tenant gate with `403 WORKSPACE_FORBIDDEN`, consistent with other non-exempt routes.

### 10.5 Source anchors

| Location | Purpose |
|---|---|
| `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/policy/GrantIntersectionEvaluator.java` | The single kernel `decide` + the `allows` / `explain` faces + `GrantExplanation` recording |
| `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/policy/RequesterAuthority.java` | `explainForUser` assembles the user path; `allowsForUser` is its `.allowed()` |
| `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/policy/AuthorizationExplainController.java` | HTTP surface (`POST /api/v1/authorization/explain`) and wire shape |
| `packages/control-plane/src/test/java/com/cc01cc/p/xihe/cp/policy/ExplainMatchesGoldenBaselineTest.java` | Proof that the 59-line baseline and explain agree |
| `packages/control-plane/src/test/java/com/cc01cc/p/xihe/cp/policy/GrantExplanationKernelTest.java` | Level index and reason assertions for six missing-surface cases (intersection / two-level parent chain / fs prefix / instance-only / capability atom / empty grants) |

## 11. Session-level temporary capability tokens (task-124 / DSD-1509 2)

- **One sentence**: this is the only explicit exception in intersection-grant authorization. A temporary table keyed by the **leaf session** makes a few `(actionClass, resource)` pairs reachable **inside that one session**. It is not a sixth evaluation layer; for those pairs it **replaces** the "every level must hold" judgement, while all other action classes still go through the per-level intersection.
- **Why it exists**: DSD-1500 R2 removed exec from both `AGENT_USER` (instance level) and `WS_EDITOR` (workspace level), while session snapshots are frozen at creation and cannot gain atoms afterward. Without this token, "a running session needs a one-off exec" would only have the option "give the principal permanent exec", which puts back what DSD-1500 removed.
- **How it takes part**: after `GrantAuthorizationService.allows` builds `permissionPath`, it appends `liveSessionTokens(...)` (direct lookup by `request.sessionId()` + the resolved leaf principal + workspace). `GrantIntersectionEvaluator.decide` checks the token first inside the `actionClass × resource` loop: a hit skips the per-level scan (explain records `level=-1`, `levelLabel=session-token`); a miss still runs the original triple loop. Resource matching is still `matchesResource`, and `fs:` declaration-key prefix semantics are not bypassed.
- **Why no cache and no scheduled task**: liveness is an SQL predicate (`revoked_at IS NULL AND expires_at > now()`); `cp.capability-cache-ttl-ms` caches only principal capabilities, not this table, so revocation and expiry take effect on the next decision.
- **Three write gates** (`SessionTemporaryGrantService.issue`): session creator (`sessions.user_id`) + holds `session:permission:configure` in that workspace + subset gate (every atom must be covered by an atom of the same actionClass held by the caller in that workspace; `fs:` is compared by in-root prefix; capability atoms are always rejected). TTL `[60, 28800]` seconds, default 900; out of range is 400, never silently truncated.
- **Read and revoke faces**: neither read nor revoke introduces a new atom — anyone who can read the session (creator or invited human) may list and revoke (the same rule as the tier face: narrowing needs no extra authorization). Revoke writes only `revoked_at`/`revoked_by_user_id`; a repeated revoke or a revoke of someone else's session row is always 404 `TEMPORARY_GRANT_NOT_FOUND`. A caller who cannot read the session gets 404 `SESSION_NOT_FOUND` first and then the creator check; **403 is never used as an existence oracle**.
- **Lifecycle**: `session_temporary_grants` (V180) has `session_id` foreign key `ON DELETE CASCADE`, so deleting the session clears the rows; revoke sets `revoked_at` instead of deleting (audit trail). Audit actions `session.temporary_grant.granted` / `session.temporary_grant.revoked`.
- **Boundary**: only the leaf session; ancestors, children, and siblings do not inherit. The subject must be that session's own PRIMARY agent principal, never supplied by the caller. `source=session_temp` is not in `GrantSources.EVALUATION_SOURCES` (it reads another table) and is used only for explain attribution.
- **Source anchors**: `policy/SessionTemporaryGrantService.java`, `policy/SessionTemporaryGrantStore.java`, `policy/SessionTemporaryGrantController.java`, `resources/db/migration/V180__dsd1509_session_temporary_grants.sql`, `policy/GrantIntersectionEvaluator.java` (`allows(..., sessionTokens)` / `explain(..., sessionTokens)`).

## 12. Reader map

| What you want to do | Read | This document's place |
|---|---|---|
| See the authorization contract itself (inputs, steps, error codes) | `spec/security/authorization.md` | This document gives the rationale and does not repeat contract fields |
| See the authentication and token path | `A03-xihe/docs/i18n/zh-Hans/DEV-024-authentication-and-security.md` | This document covers only step 1 |
| See the policy subsystem in the CP architecture | `A03-xihe/docs/i18n/zh-Hans/DEV-014-control-plane-architecture.md` §8e, §8e-2 | This document adds "why it is designed this way" |
| Find which term to use | `A03-xihe/docs/i18n/zh-Hans/DEV-032-terminology.md` | This document is the basis for the term entry |
| Review PEP coverage or migration | This document §5, §8, §9 | — |
| Answer "why was this denied" | This document §10 and `explainAuthorization` in `A03-xihe/docs/api/openapi.yaml` | This document gives the rationale; the contract fields follow OpenAPI |
