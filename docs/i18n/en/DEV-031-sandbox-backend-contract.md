---
title: DEV-031 - Sandbox Backend Contract
category: dev-guide
sidebar_order: 31
lang: en
sidebar_group: "Developer Guide"
status: active
created: 2026-09-15
---

# DEV-031: Sandbox Backend Contract

> For Runtime developers and backend-swap evaluations: the `SandboxBackend` required interface (verbs plus the capability query), capability declaration, and cross-backend semantic constraints (§1–5); the three-tier mapping for long-running stdio MCP (§6); and the Docker backend status map (§7). Design principles live in the `sandbox-backend-abstraction` skill; the leak audit record is in PLAN-0329.

## 1. Scope and Boundaries

- The contract describes *how upper layers request an execution environment*; Docker, port publishing, and in-sandbox HTTP never cross this layer.
- Current seam (the interface boundary between upper-layer calls and backend implementations): `execute` is converged in `WorkspaceExecutionRouter` (per-request exec); `ensure/destroy` still live in the `WorkspaceManager`/`WorkspaceRegistry` dual path, to be converged by the workspace lifecycle initiative — this contract describes the **target state**.
- Six invariants (constraints that every backend implementation must always satisfy):
  1. Every required interface has a non-empty implementation on all backends;
  2. A missing capability returns an explicit `UNSUPPORTED` (not supported) result and never silently degrades (see §3);
  3. No Docker concepts above the seam;
  4. A capability declaration must include both the declared support and the measured result; if the two disagree, refuse rather than allow (see §3);
  5. Connections may drop and clients must be able to reconnect (see §5);
  6. Destroying the execution entity must not delete workspace data (see §5).

## 2. Required Interface

| Interface | Semantics | Boundaries |
|---|---|---|
| `ensure(spec) -> handle` | Ensure the execution environment exists and return a handle (provision: create or activate the execution environment; idempotent: repeated calls yield the same result) | Rebuildable; rebuild/destroy MUST NOT delete WorkspaceStorage; an unsatisfiable spec fails closed (refuse rather than allow) instead of substituting local defaults |
| `destroy(handle)` | Destroy the execution entity (container/VM/process tree) | Repeatable; failures must be distinguishable (`cleanup_failed`) and never masked by exit code 0 |
| `execute(op) -> result` | Operation-scoped execution: explicit argv/cwd/env; streaming output; cancellable; timeout and exit code | Bounded and cancellable; no implicit shell state |
| `capabilities() -> map` | Capability query: returns declared support and measured results (defined in §3) | Required on every backend; calling an undeclared capability returns `UNSUPPORTED` |

Rule: if an interface can only raise "unsupported" on some backend, it cannot be required — demote it to that backend's capability declaration.

## 3. Capability Declaration and `UNSUPPORTED`

```
capabilities() -> { <capability>: { declared, probed, reason } }
```

- All three of `declared` (declared support), `probed` (measured at startup or before call) and `reason` (why unsupported or degraded) are required; a mismatch between `declared` and `probed` is **fail-closed**.
- Probe failure or unimplemented capability → explicit degradation or refusal; silent degradation is forbidden (evidence: Claude defaults to fail-open, i.e. allowing instead of blocking on failure; Landlock `BestEffort` silently filters; Codex on Windows silently downgrades `workspace-write` to read-only when its sandbox is disabled).
- Calling an undeclared capability → returns `UNSUPPORTED` with `reason`; callers branch **on capabilities, not backend names**.

## 4. Optional Capabilities

| Capability | Semantics |
|---|---|
| `session` | Durable session (multiple executions keeping process state): duplex stream + process lifetime + `reconnect` (connections necessarily die after snapshot/restore/rebuild; clients must reconnect) |
| `fs_transfer` | Upload/download; prefer workspace mount when available, transfer as fallback |
| `network(policy)` | Expressiveness tier: `none` / on-off / domain-or-IP lists / port-level |
| `snapshot_revert` | Dimensions are separate: **fs / memory / boot-template**; `in-place revert` (roll back the same environment) vs `clone-from-snapshot` (start a new environment from a snapshot) are distinct semantics |
| `pause_resume` | Must state what is retained: fs only (processes die) or fs+memory (processes continue) |
| `endpoint(port) -> URL` | Port to reachable URL; must declare **reachability scope** (local / host / public) |
| `pty` | Interactive terminal (execute semantics plus TTY, i.e. a terminal device) |
| `watch` | File/directory change events |

**Reserved names (no semantics, no implementation binding)**: `host_tools`, `display`, `gpu`, `identity`, `fs_view`, `checkpoint`. Reserved only to avoid future renames; do not pre-build mechanisms on them.

## 5. Cross-Backend Semantic Constraints

> Five constraints the upper layers must know when replacing Docker with another backend (microVM / remote execution). Terms are explained at first occurrence.

1. **Separate workspace data from the execution entity**: workspace data (code and files) lives in workspace storage (`hostRoot/<workspaceId>`); the sandbox is a replaceable execution entity. Deleting or rebuilding a container does not affect workspace data — `destroy` only removes the execution entity and never the workspace directory.
2. **Connections will drop; reconnection is required**: snapshot, pause/resume, and rebuild invalidate existing connections by backend design, not as failures: E2B interrupts all WebSocket/PTY/command streams on snapshot; Firecracker resets vsock (a virtual socket) on restore; gVisor peers receive `ECONNRESET` (the connection-reset error code) after restore. Long-lived channels (MCP bridges, event streams) must therefore reconnect and resume sessions; `session` treats `reconnect` as part of its definition and assumes no persistent connection.
3. **Snapshots are declared by dimension**: a snapshot must state its restore scope; never assume it is a full capture:
   - fs snapshot (filesystem): files remain, processes are lost (equivalent to a reboot);
   - memory snapshot: processes continue, but connections still drop (reconnect per item 2);
   - boot template: only a starting point, no runtime state.
   Backends differ (e.g., Runloop disk-only, E2B includes memory); callers expect exactly the declared dimension.
4. **Network policy is declared by expressiveness**: "can it reach the network" is not a boolean; granularity varies by backend:
   - network namespace (Linux network isolation unit): on/off only;
   - HTTP proxy: domain allowlists (XH's audit-proxy is this tier);
   - microVM: egress goes through a tunnel (a host-side forwarding channel) with its own granularity.
   The contract declares the expressiveness tier; callers choose accordingly.
5. **Workspace file access mode**: how files enter the sandbox is backend-defined; the contract only promises that workspace data is visible inside the sandbox and is not lost with the sandbox lifecycle. The three modes have distinct semantics:
   - mount (e.g., bind mount, virtiofs): host and sandbox share the same files, changes visible immediately (XH today);
   - sync: a copy is pushed in and synced back to workspace storage, with delay and conflict handling;
   - copy: one transfer in and out; simplest, slowest.
   When the sandbox files and workspace storage diverge, workspace storage wins.

## 6. Long-Running stdio MCP: Three Tiers

> stdio (standard input/output pipes) is the default MCP transport for local processes; these MCP server processes run **inside the workspace container** (they need the container's files and environment), so the host side needs a channel to talk to them. "Three tiers" below means the support level the contract defines for such long-running processes.

| Tier | Condition | Behavior |
|---|---|---|
| 1. session | Backend declares `session` | Host acts as the client and exchanges messages over the session's duplex stream; process lifetime is carried by the session |
| 2. per-call execute | Only `execute` | A new process per call (MCP itself carries no session state; the cost is cold start and no in-process state) |
| 3. Unsupported | Neither | Returns `UNSUPPORTED` (fail-closed; no silent rerouting) |

Status: the current MCP bridge depends on an in-sandbox HTTP service plus a published port and container-IP resolution; it works only on the Docker backend, is not a general `session` capability, and is listed as "to be migrated". On native Windows its dynamic port is unreachable (measured), so this form is unusable there.

## 7. Docker Backend Status Map

| Contract item | Current implementation | Note |
|---|---|---|
| `execute` | per-request exec (`xihe-container-runtime --oneshot`) | Above the seam already |
| `ensure` / `destroy` | Container lifecycle + hydration rebuild; `WorkspaceManager`/`Registry` dual path | Convergence owned by the workspace lifecycle initiative |
| `session` | bridge (HTTP + published port) | "To be migrated" in the leak inventory |
| `endpoint(port)` | 39001 publish + random host port | "Vestigial" (left over with no consumers) |
| `network(policy)` | `network_mode` none/bridge + proxy env | Below-seam implementation |
| Snapshot/rollback | Not in the sandbox layer (belongs to the workspace file-change layer, owned by PLAN-0328) | Kept separate from the execution entity |

## 8. Change Rules

- The contract evolves by adding capabilities, never by introducing backend-name branches; once frozen, changes must be recorded as a supersede entry in the owning PLAN.
- New backends implement the contract plus `capabilities()`; consumers branch on capabilities and fail with `UNSUPPORTED` where support is missing.
