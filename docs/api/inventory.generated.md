# Xihe API inventory（生成版）

> **生成文件，请勿手改。** 由 `scripts/gen-api-docs.mjs` 从 `docs/api/openapi.yaml` 生成。
> 重新生成：`mise run gen:api-docs` ｜ 校验是否落后：`mise run check:api-docs`（不一致 exit 1）。
> 人工叙述版（含路由迁移对照、调用方、错误契约 —— 这些 yaml 表达不了）仍在 [inventory.md](./inventory.md)，本文件**不替代**它。

- 契约：`docs/api/openapi.yaml`（OpenAPI 3.1.0）
- 规模：**356** operations ／ **2** 个分组 ／ **20** 个 tag；面分布 公开 256 · 服务间 100
- security 列：`bearerAuth` = 声明了 bearer 方案；`public` = 显式 `security: []`；`—` = 未声明（全局 security 为空，实际语义也按公开处理）。未声明共 0 个操作。
- 分组口径：两级 —— 顶层 `x-tagGroups`（public 17 tags / internal 3 tags）÷ `operation.tags[0]`（356 / 356 个操作带 tag）。

## public（256 operations · 公开 · 17 tags）

### auth（11）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/auth/bootstrap-status` | `authBootstrapStatus` | `public` | Check whether the instance still needs bootstrap | 公开 |
| `POST /api/v1/auth/login` | `login` | `public` | Log in and obtain an access token | 公开 |
| `GET /api/v1/auth/me` | `currentUser` | `bearerAuth` | Get the current authenticated user | 公开 |
| `POST /api/v1/auth/refresh` | `refresh` | `public` | Refresh an expired access token | 公开 |
| `POST /api/v1/auth/register` | `register` | `public` | Register a new user account | 公开 |
| `GET /api/v1/instance/owner` | `getInstanceOwner` | `bearerAuth` | Read the instance owner pointer (PLAN-0580) | 公开 |
| `PUT /api/v1/instance/owner` | `transferInstanceOwner` | `bearerAuth` | Transfer instance ownership (PLAN-0580) | 公开 |
| `GET /api/v1/me/permissions` | `myPermissions` | `bearerAuth` | Effective capabilities of the caller (PLAN-0610 W3-2b) | 公开 |
| `GET /api/v1/oauth/callback` | `oauthCallback` | `public` | OAuth redirect callback | 公开 |
| `POST /api/v1/oauth/revoke` | `revokeOAuthSession` | `bearerAuth` | Revoke an OAuth session | 公开 |
| `POST /api/v1/oauth/sessions` | `startOAuthSession` | `bearerAuth` | Start an OAuth session for a provider | 公开 |

### admin（26）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/audit/entries` | `listAuditEntries` | `bearerAuth` | List audit entries | 公开 |
| `GET /api/v1/audit/entries/{type}/{id}` | `getAuditEntryDetail` | `bearerAuth` | Get one audit entry by type and id | 公开 |
| `GET /api/v1/bindings` | `listRoleBindings` | `bearerAuth` | Read the binding set of one scope (PLAN-0610 W3-2a) | 公开 |
| `PUT /api/v1/bindings` | `replaceRoleBindings` | `bearerAuth` | Replace the binding set of one scope (PLAN-0610 W3-2a) | 公开 |
| `GET /api/v1/instance/identity` | `getInstanceIdentity` | `bearerAuth` | Read the deployment instance identity (PLAN-0767 M1) | 公开 |
| `GET /api/v1/org-units` | `listOrgUnits` | `bearerAuth` | List org-unit nodes (tree top, lazy-loaded children, or name search) | 公开 |
| `POST /api/v1/org-units` | `createOrgUnit` | `bearerAuth` | Create an org unit (a root when parentId is null) | 公开 |
| `PATCH /api/v1/org-units/{unitId}` | `renameOrgUnit` | `bearerAuth` | Rename an org unit | 公开 |
| `GET /api/v1/org-units/{unitId}/members` | `listOrgUnitMembers` | `bearerAuth` | List the humans and agent principals attached to one org unit | 公开 |
| `PUT /api/v1/org-units/{unitId}/members/{memberId}` | `moveOrgUnitMember` | `bearerAuth` | Add or move one human/agent into an org unit (G1: affected workspaces + audit + confirmation) | 公开 |
| `DELETE /api/v1/org-units/{unitId}/members/{memberId}` | `removeOrgUnitMember` | `bearerAuth` | Remove one human/agent from an org unit | 公开 |
| `PUT /api/v1/org-units/{unitId}/parent` | `moveOrgUnit` | `bearerAuth` | Move an org unit under a new parent (rejects rings with 422) | 公开 |
| `PUT /api/v1/org-units/{unitId}/role-bindings` | `replaceOrgUnitRoleBindings` | `bearerAuth` | Replace an org unit's role bindings as one set | 公开 |
| `GET /api/v1/principal-grants/{username}` | `readPrincipalGrants` | `bearerAuth` | '[RETIRED — 410 tombstone] 管理员直授写面 (PLAN-0585) 的只读入口' | 公开 |
| `PATCH /api/v1/principal-grants/{username}` | `patchPrincipalGrants` | `bearerAuth` | '[RETIRED — 410 tombstone] 管理员直授写面 (PLAN-0585) 的写入入口' | 公开 |
| `GET /api/v1/roles` | `listRoles` | `bearerAuth` | List access-role definitions (PLAN-0610 W3-2a; PLAN-0667 gap-1 read path) | 公开 |
| `POST /api/v1/roles` | `createRole` | `bearerAuth` | Create a custom access role (PLAN-0610 W3-2a) | 公开 |
| `GET /api/v1/roles/catalog` | `getRoleCatalog` | `bearerAuth` | Access-role atom catalog (PLAN-0610 W3-2a; labels PLAN-0651 D51-37) | 公开 |
| `PATCH /api/v1/roles/{roleId}` | `updateRole` | `bearerAuth` | Update an access role (PLAN-0610 W3-2a) | 公开 |
| `DELETE /api/v1/roles/{roleId}` | `deleteRole` | `bearerAuth` | Delete a custom access role (PLAN-0610 W3-2a) | 公开 |
| `GET /api/v1/users` | `listUsers` | `bearerAuth` | Admin user list (PLAN-0581) | 公开 |
| `POST /api/v1/users` | `createUser` | `bearerAuth` | Admin account creation (PLAN-0581) | 公开 |
| `GET /api/v1/users/{userId}` | `getUser` | `bearerAuth` | Admin user detail (PLAN-0581) | 公开 |
| `DELETE /api/v1/users/{userId}` | `softDeleteUser` | `bearerAuth` | Soft-delete an account (PLAN-0581) | 公开 |
| `POST /api/v1/users/{userId}/password-reset` | `resetUserPassword` | `bearerAuth` | Admin password reset (PLAN-0581) | 公开 |
| `PATCH /api/v1/users/{userId}/status` | `changeUserStatus` | `bearerAuth` | Enable or disable an account (PLAN-0581) | 公开 |

### workspace（32）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/workspace-imports/{importId}` | `getWorkspaceImport` | `bearerAuth` | Get one workspace import by id | 公开 |
| `POST /api/v1/workspace-imports/{importId}/cancel` | `cancelWorkspaceImport` | `bearerAuth` | Cancel a running workspace import | 公开 |
| `GET /api/v1/workspaces` | `listWorkspaces` | `bearerAuth` | List workspaces visible to the caller | 公开 |
| `POST /api/v1/workspaces` | `createWorkspace` | `bearerAuth` | Create a new workspace | 公开 |
| `POST /api/v1/workspaces/capabilities/preflight` | `preflightWorkspaceCapability` | `bearerAuth` | Preflight the execution backend capability before creating a Workspace | 公开 |
| `GET /api/v1/workspaces/current` | `getCurrentWorkspace` | `bearerAuth` | Get the caller's current workspace | 公开 |
| `GET /api/v1/workspaces/import-sources` | `listWorkspaceImportSources` | `bearerAuth` | List available workspace import sources | 公开 |
| `GET /api/v1/workspaces/{workspaceId}` | `getWorkspace` | `bearerAuth` | Get one workspace by id | 公开 |
| `PATCH /api/v1/workspaces/{workspaceId}` | `updateWorkspace` | `bearerAuth` | Update workspace settings | 公开 |
| `DELETE /api/v1/workspaces/{workspaceId}` | `deleteWorkspace` | `bearerAuth` | Delete a workspace | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/checkpoints` | `listWorkspaceCheckpoints` | `bearerAuth` | List the workspace checkpoint slices | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/checkpoints/blob` | `getWorkspaceCheckpointBlob` | `bearerAuth` | Read one plain-text file from a slice | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/checkpoints/cleanup` | `cleanupWorkspaceCheckpoints` | `bearerAuth` | Physically clear all workspace checkpoint history | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/checkpoints/gc` | `runWorkspaceCheckpointGc` | `bearerAuth` | Run the Runtime retention sweep for one workspace | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/checkpoints/retention` | `getWorkspaceCheckpointRetention` | `bearerAuth` | Checkpoint retention constants and current slice/ref counts | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/checkpoints/revert` | `executeWorkspaceCheckpointRevert` | `bearerAuth` | Restore a workspace to a slice | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/checkpoints/revert/preview` | `previewWorkspaceCheckpointRevert` | `bearerAuth` | Preview restoring a workspace to a slice | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/environment` | `getWorkspaceEnvironment` | `bearerAuth` | Get environment variables of one workspace | 公开 |
| `PATCH /api/v1/workspaces/{workspaceId}/execution-mode` | `updateWorkspaceExecutionMode` | `bearerAuth` | Update the execution mode of one workspace | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/git-status` | `getWorkspaceGitStatus` | `bearerAuth` | User-repository git status (dual-diff "待提交" side) | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/imports` | `listWorkspaceImports` | `bearerAuth` | List imports of one workspace | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/imports` | `createWorkspaceImport` | `bearerAuth` | Start a new workspace import | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/materialize` | `materializeWorkspace` | `bearerAuth` | Materialize one workspace | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/members` | `listWorkspaceMembers` | `bearerAuth` | List workspace members (PLAN-0565) | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/members` | `addWorkspaceMember` | `bearerAuth` | Add an existing account as a workspace member (PLAN-0565) | 公开 |
| `PATCH /api/v1/workspaces/{workspaceId}/members/{userId}` | `updateWorkspaceMemberRole` | `bearerAuth` | Change one member's role (PLAN-0565) | 公开 |
| `DELETE /api/v1/workspaces/{workspaceId}/members/{userId}` | `removeWorkspaceMember` | `bearerAuth` | Remove one member (PLAN-0565) | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/nested-repos` | `listWorkspaceNestedRepos` | `bearerAuth` | Nested git repositories discovered in a workspace (PLAN-0641 T2.3, TTL-cached) | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/roots` | `addWorkspaceRoot` | `bearerAuth` | Add a root to a multi-root workspace (PLAN-0639 D39-3) | 公开 |
| `PATCH /api/v1/workspaces/{workspaceId}/roots/{rootId}` | `updateWorkspaceRoot` | `bearerAuth` | Update root alias or position (PLAN-0639 D39-3) | 公开 |
| `DELETE /api/v1/workspaces/{workspaceId}/roots/{rootId}` | `deleteWorkspaceRoot` | `bearerAuth` | Soft-delete a root (PLAN-0639 D39-3) | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/runtime/release` | `releaseWorkspaceRuntime` | `bearerAuth` | Release workspace execution resources (any accessible member) | 公开 |

### agent（27）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/agent-principals` | `listAgentPrincipals` | `bearerAuth` | List Agent principals visible to the caller | 公开 |
| `POST /api/v1/agent-principals` | `createAgentPrincipal` | `bearerAuth` | Create an Agent principal from a readable template snapshot | 公开 |
| `PATCH /api/v1/agent-principals/{principalId}` | `updateAgentPrincipalDocuments` | `bearerAuth` | Replace an Agent principal's hook subscriptions and/or memory policy | 公开 |
| `POST /api/v1/agent-principals/{principalId}/disable` | `disableAgentPrincipal` | `bearerAuth` | Disable an Agent principal (bodies are never hard-deleted) | 公开 |
| `GET /api/v1/agent-principals/{principalId}/memories` | `listAgentMemories` | `bearerAuth` | List one agent's memory (subject-level, V107) | 公开 |
| `POST /api/v1/agent-principals/{principalId}/memories` | `createAgentMemory` | `bearerAuth` | Write one agent memory assertion (subject-level, V107) | 公开 |
| `PATCH /api/v1/agent-principals/{principalId}/memories/{memoryId}` | `updateAgentMemory` | `bearerAuth` | Edit one agent memory assertion (subject-level, V107) | 公开 |
| `DELETE /api/v1/agent-principals/{principalId}/memories/{memoryId}` | `deleteAgentMemory` | `bearerAuth` | Archive (soft-delete) one agent memory assertion (subject-level, V107) | 公开 |
| `GET /api/v1/agent-principals/{principalId}/roles` | `listAgentPrincipalRoles` | `bearerAuth` | List one agent principal's role bindings (PLAN-0667) | 公开 |
| `POST /api/v1/agent-principals/{principalId}/roles` | `bindAgentPrincipalRole` | `bearerAuth` | Bind one role to an agent principal (PLAN-0667) | 公开 |
| `DELETE /api/v1/agent-principals/{principalId}/roles/{bindingId}` | `unbindAgentPrincipalRole` | `bearerAuth` | Remove one role binding from an agent principal (PLAN-0667) | 公开 |
| `GET /api/v1/agent-principals/{principalId}/skills` | `listAgentPrincipalSkills` | `bearerAuth` | List one agent principal's skill bindings (PLAN-0667) | 公开 |
| `POST /api/v1/agent-principals/{principalId}/skills` | `bindAgentPrincipalSkill` | `bearerAuth` | Bind one skill to an agent principal (PLAN-0667) | 公开 |
| `DELETE /api/v1/agent-principals/{principalId}/skills/{bindingId}` | `unbindAgentPrincipalSkill` | `bearerAuth` | Remove one skill binding from an agent principal (PLAN-0667) | 公开 |
| `GET /api/v1/agent-templates` | `listAgentTemplates` | `bearerAuth` | Read one caller-readable Agent template config layer | 公开 |
| `GET /api/v1/instance/agent-principals` | `listInstanceAgentPrincipals` | `bearerAuth` | List the instance platform agents (every authenticated caller) | 公开 |
| `POST /api/v1/instance/agent-principals` | `createInstanceAgentPrincipal` | `bearerAuth` | Create an instance platform agent (instance admin only) | 公开 |
| `PATCH /api/v1/instance/agent-principals/{principalId}` | `updateInstanceAgentPrincipalDocuments` | `bearerAuth` | Update an instance platform agent's documents (instance admin only) | 公开 |
| `DELETE /api/v1/instance/agent-principals/{principalId}` | `deleteInstanceAgentPrincipal` | `bearerAuth` | Retire an instance platform agent (instance admin only; never a hard delete) | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/agents` | `listWorkspaceAgents` | `bearerAuth` | List the Agent principals a Workspace can use | 公开 |
| `PUT /api/v1/workspaces/{workspaceId}/agents/{principalId}` | `setWorkspaceAgentCap` | `bearerAuth` | Add or update one Workspace Agent binding cap | 公开 |
| `DELETE /api/v1/workspaces/{workspaceId}/agents/{principalId}` | `unbindWorkspaceAgent` | `bearerAuth` | Remove one Workspace Agent binding | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/agents/{principalId}/effective-cap` | `getWorkspaceAgentEffectiveCap` | `bearerAuth` | Read the live effective cap of one Workspace Agent | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/agents/{principalId}/memories` | `listWorkspaceAgentMemories` | `bearerAuth` | [DEPRECATED] List one agent's memory (subject-level route preferred) | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/agents/{principalId}/memories` | `createWorkspaceAgentMemory` | `bearerAuth` | [DEPRECATED] Write one agent memory assertion (subject-level route preferred) | 公开 |
| `PATCH /api/v1/workspaces/{workspaceId}/agents/{principalId}/memories/{memoryId}` | `updateWorkspaceAgentMemory` | `bearerAuth` | [DEPRECATED] Edit one agent memory assertion (subject-level route preferred) | 公开 |
| `DELETE /api/v1/workspaces/{workspaceId}/agents/{principalId}/memories/{memoryId}` | `deleteWorkspaceAgentMemory` | `bearerAuth` | [DEPRECATED] Archive (soft-delete) one agent memory assertion (subject-level route preferred) | 公开 |

### session（31）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/conversation-threads` | `createConversationThread` | `bearerAuth` | Create a conversation thread | 公开 |
| `GET /api/v1/conversation-threads/{threadId}` | `readConversationThread` | `bearerAuth` | Read one conversation thread | 公开 |
| `POST /api/v1/conversation-threads/{threadId}/sessions` | `attachConversationThreadSession` | `bearerAuth` | Attach a session to a conversation thread | 公开 |
| `GET /api/v1/sessions` | `listSessions` | `bearerAuth` | List chat sessions | 公开 |
| `POST /api/v1/sessions` | `createSession` | `bearerAuth` | Create a new chat session | 公开 |
| `GET /api/v1/sessions/{sessionId}` | `getSession` | `bearerAuth` | Get one session by id | 公开 |
| `PATCH /api/v1/sessions/{sessionId}` | `updateSession` | `bearerAuth` | Update session metadata | 公开 |
| `DELETE /api/v1/sessions/{sessionId}` | `deleteSession` | `bearerAuth` | Delete one session | 公开 |
| `PATCH /api/v1/sessions/{sessionId}/api-request-template` | `updateSessionApiRequestTemplate` | `bearerAuth` | Set the API request template override of one session | 公开 |
| `POST /api/v1/sessions/{sessionId}/bind-defaults` | `bindSessionDefaults` | `bearerAuth` | Rebind a legacy bare Session to the default provider binding (2026-11-04 P0) | 公开 |
| `GET /api/v1/sessions/{sessionId}/branches` | `listSessionBranches` | `bearerAuth` | List branches of one session | 公开 |
| `POST /api/v1/sessions/{sessionId}/branches` | `createSessionBranch` | `bearerAuth` | Create a new session branch | 公开 |
| `GET /api/v1/sessions/{sessionId}/commands` | `listSessionCommands` | `bearerAuth` | List commands recorded in one session | 公开 |
| `POST /api/v1/sessions/{sessionId}/compact` | `compactSessionContext` | `bearerAuth` | Compact the context of one session | 公开 |
| `POST /api/v1/sessions/{sessionId}/delegation-spawn` | `delegateSpawn` | `bearerAuth` | Human delegation — create a budgeted child Session owned by an agent principal (PLAN-0655) | 公开 |
| `GET /api/v1/sessions/{sessionId}/delegation-usage` | `getSessionDelegationUsage` | `bearerAuth` | Read-only delegation budget view for the Session's delegation root (PLAN-0655); the SAME evaluation… | 公开 |
| `GET /api/v1/sessions/{sessionId}/derived-state` | `getSessionDerivedState` | `bearerAuth` | Get derived state of one session | 公开 |
| `GET /api/v1/sessions/{sessionId}/export` | `exportSessionMarkdown` | `bearerAuth` | Export one session as Markdown | 公开 |
| `GET /api/v1/sessions/{sessionId}/follow-ups` | `getFollowUpQueue` | `bearerAuth` | Get the follow-up queue of one session | 公开 |
| `POST /api/v1/sessions/{sessionId}/follow-ups` | `enqueueFollowUp` | `bearerAuth` | Enqueue a follow-up item | 公开 |
| `POST /api/v1/sessions/{sessionId}/follow-ups/continue` | `continueFollowUpQueue` | `bearerAuth` | Continue processing the follow-up queue | 公开 |
| `DELETE /api/v1/sessions/{sessionId}/follow-ups/{itemId}` | `withdrawFollowUp` | `bearerAuth` | Withdraw one follow-up item | 公开 |
| `POST /api/v1/sessions/{sessionId}/fork` | `forkSession` | `bearerAuth` | Create an independent child Session from a terminal branch anchor | 公开 |
| `GET /api/v1/sessions/{sessionId}/messages` | `listMessages` | `bearerAuth` | List messages of one session | 公开 |
| `DELETE /api/v1/sessions/{sessionId}/messages/{messageId}` | `deleteMessage` | `bearerAuth` | Delete one message | 公开 |
| `GET /api/v1/sessions/{sessionId}/participants` | `listSessionParticipants` | `bearerAuth` | List the session participants (PLAN-0623 M0 contract; wired in M1) | 公开 |
| `POST /api/v1/sessions/{sessionId}/participants` | `addSessionParticipant` | `bearerAuth` | Add a member or guard participant (PRIMARY is created with the session, never here) | 公开 |
| `PATCH /api/v1/sessions/{sessionId}/participants/{participantId}` | `updateSessionParticipant` | `bearerAuth` | Change a participant's wake/respond policy or disable it | 公开 |
| `DELETE /api/v1/sessions/{sessionId}/participants/{participantId}` | `removeSessionParticipant` | `bearerAuth` | Remove a member/guard participant (the PRIMARY is not removable) | 公开 |
| `PATCH /api/v1/sessions/{sessionId}/participants/{participantId}/cursor` | `advanceParticipantCursor` | `bearerAuth` | Advance the caller's own read cursor for this session | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/sessions` | `createWorkspaceSession` | `bearerAuth` | Create a session under an explicit workspace (PLAN-0608) | 公开 |

### chat（17）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/approvals/pending` | `listPendingApprovals` | `bearerAuth` | Cross-session live actionable approval/retry indicator (counts only) | 公开 |
| `POST /api/v1/chat` | `chat` | `bearerAuth` | Enqueue a chat turn (requires active SSE) | 公开 |
| `POST /api/v1/chat/approvals/{requestId}/decision` | `decideChatApproval` | `bearerAuth` | Submit a user decision for a pending Chat approval | 公开 |
| `GET /api/v1/chat/runs/{runId}` | `getChatRunStatus` | `bearerAuth` | Get a ChatRun status and its pending approvals | 公开 |
| `GET /api/v1/chat/runs/{runId}/attempts` | `getChatRunAttempts` | `bearerAuth` | List a ChatRun's durable provider HTTP transport attempts | 公开 |
| `POST /api/v1/chat/runs/{runId}/cancel` | `cancelChatRun` | `bearerAuth` | Cancel a ChatRun (PLAN-275 M1 T1.3) | 公开 |
| `GET /api/v1/chat/runs/{runId}/context-fingerprint` | `getChatRunContextFingerprint` | `bearerAuth` | Read a run's context fingerprint, optionally diffed against another run | 公开 |
| `GET /api/v1/chat/runs/{runId}/guidance` | `getChatRunGuidance` | `bearerAuth` | Snapshot the run's Guidance records ordered by sequence | 公开 |
| `POST /api/v1/chat/runs/{runId}/guidance` | `submitChatRunGuidance` | `bearerAuth` | Submit in-run Guidance (same-Run steering) for an active ChatRun | 公开 |
| `GET /api/v1/chat/runs/{runId}/provider-request-fingerprint` | `getChatRunProviderRequestFingerprint` | `bearerAuth` | Read a run's provider-request fingerprint, optionally diffed against another run | 公开 |
| `GET /api/v1/chat/runs/{runId}/trace` | `getChatRunTrace` | `bearerAuth` | Read a bounded, privacy-safe timeline of durable ChatRun facts | 公开 |
| `POST /api/v1/chat/runs/{sourceRunId}/continue` | `continueChatRun` | `bearerAuth` | Continue an eligible ChatRun from its latest safe graph checkpoint | 公开 |
| `GET /api/v1/chat/sessions/{sessionId}/monitor` | `getSessionMonitor` | `bearerAuth` | Read-only Session monitor aggregate (activity, history window, readiness) | 公开 |
| `GET /api/v1/chat/sessions/{sessionId}/runs` | `listSessionChatRuns` | `bearerAuth` | List a Session's ChatRuns with status and spawn waiting link | 公开 |
| `GET /api/v1/user-questions` | `listUserQuestions` | `bearerAuth` | The caller's own inbound questions (the asker's inbox) | 公开 |
| `GET /api/v1/user-questions/{id}` | `getUserQuestion` | `bearerAuth` | One question — addressee, or a session-visible reader (read-only) | 公开 |
| `POST /api/v1/user-questions/{id}/answer` | `answerUserQuestion` | `bearerAuth` | Answer a pending question (addressee only) | 公开 |

### event（3）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/events` | `chatEvents` | `bearerAuth` | Subscribe to session-scoped persistent SSE | 公开 |
| `GET /api/v1/user-events` | `userEvents` | `bearerAuth` | Subscribe to the user-level persistent SSE channel | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/events` | `workspaceEvents` | `bearerAuth` | Subscribe to workspace-scoped file and lifecycle SSE | 公开 |

### config（27）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/api-input-types` | `listApiInputTypes` | `bearerAuth` | List built-in immutable API Type definitions | 公开 |
| `POST /api/v1/api-input-types/{apiTypeId}/versions/{version}/validate` | `validateApiRequestTemplate` | `bearerAuth` | Validate an API request template | 公开 |
| `GET /api/v1/config-locks` | `listConfigLocks` | `bearerAuth` | Read the admin config-lock catalog (PLAN-0556) | 公开 |
| `PUT /api/v1/config-locks/{domain}/{key}` | `lockConfigKey` | `bearerAuth` | Lock one config key and pin its instance value (PLAN-0556) | 公开 |
| `DELETE /api/v1/config-locks/{domain}/{key}` | `unlockConfigKey` | `bearerAuth` | Unlock one config key (PLAN-0556) | 公开 |
| `GET /api/v1/config/api-request-templates` | `listApiRequestTemplates` | `bearerAuth` | List API request templates of the caller's scope | 公开 |
| `GET /api/v1/config/embedding/effective` | `getEmbeddingEffectiveProfile` | `bearerAuth` | Read-only effective embedding profile for the settings surface | 公开 |
| `POST /api/v1/config/embedding/test` | `testEmbeddingProfile` | `bearerAuth` | Probe the resolved embedding profile through the Agent | 公开 |
| `GET /api/v1/config/export` | `exportConfig` | `bearerAuth` | Export the config bundle | 公开 |
| `POST /api/v1/config/import` | `importConfig` | `bearerAuth` | Import an instance config bundle | 公开 |
| `PUT /api/v1/config/instance/{domain}` | `putInstanceConfig` | `bearerAuth` | Write instance-layer config of one domain | 公开 |
| `DELETE /api/v1/config/instance/{domain}/{key}` | `deleteInstanceConfig` | `bearerAuth` | Clear one instance-layer default (PLAN-0554) | 公开 |
| `PUT /api/v1/config/user/{domain}` | `putUserConfig` | `bearerAuth` | Write user-layer config of one domain | 公开 |
| `PUT /api/v1/config/workspace-default/{domain}` | `putWorkspaceDefaultConfig` | `bearerAuth` | Write the shared workspace-default layer of one domain | 公开 |
| `DELETE /api/v1/config/workspace-default/{domain}/{key}` | `deleteWorkspaceDefaultConfig` | `bearerAuth` | Clear one workspace-default-layer row so the chain inherits again | 公开 |
| `PUT /api/v1/config/workspace/{domain}` | `putWorkspaceConfig` | `bearerAuth` | (deprecated) Write one workspace-layer config domain | 公开 |
| `GET /api/v1/config/{domain}` | `getConfig` | `bearerAuth` | Get config of one domain (merged effective, or one explicit layer) | 公开 |
| `GET /api/v1/config/{domain}/meta` | `getConfigMeta` | `bearerAuth` | Read per-key config provenance for one layer (PLAN-0554) | 公开 |
| `PUT /api/v1/config/{layer}/api-request-templates` | `saveApiRequestTemplates` | `bearerAuth` | Save API request templates for one layer | 公开 |
| `GET /api/v1/context/{sessionId}/sources` | `getContextSources` | `bearerAuth` | Get context sources of one session | 公开 |
| `GET /api/v1/models` | `listModels` | `bearerAuth` | List verified provider models for Chat | 公开 |
| `GET /api/v1/policy/domains` | `listPolicyDomains` | `bearerAuth` | List action-class domains with their effective layer | 公开 |
| `GET /api/v1/policy/mode` | `getPolicyMode` | `bearerAuth` | Get the session-scoped policy mode | 公开 |
| `POST /api/v1/policy/mode` | `setPolicyMode` | `bearerAuth` | Set the session-scoped policy mode | 公开 |
| `GET /api/v1/policy/tool-faces` | `listPolicyToolFaces` | `bearerAuth` | List built-in and persisted tool classifications | 公开 |
| `POST /api/v1/policy/tool-faces` | `upsertPolicyToolFace` | `bearerAuth` | Classify a tool face | 公开 |
| `GET /api/v1/provider-catalog` | `listProviderCatalog` | `bearerAuth` | List connectable provider definitions | 公开 |

### provider（7）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/provider-connections` | `listProviderConnections` | `bearerAuth` | List provider connections visible to the current user | 公开 |
| `POST /api/v1/provider-connections` | `createProviderConnection` | `bearerAuth` | Create and persist an encrypted provider connection | 公开 |
| `PATCH /api/v1/provider-connections/{connectionId}` | `updateProviderConnection` | `bearerAuth` | Update provider connection metadata or replace credential | 公开 |
| `DELETE /api/v1/provider-connections/{connectionId}` | `deleteProviderConnection` | `bearerAuth` | Disable and remove a provider connection | 公开 |
| `GET /api/v1/provider-connections/{connectionId}/api-type-change-impact` | `getProviderApiTypeChangeImpact` | `bearerAuth` | Preview the impact of changing a provider connection's API type | 公开 |
| `GET /api/v1/provider-connections/{connectionId}/delete-impact` | `getProviderDeleteImpact` | `bearerAuth` | Preview the config references a connection delete would cascade away | 公开 |
| `POST /api/v1/provider-connections/{connectionId}/verify` | `verifyProviderConnection` | `bearerAuth` | Verify a persisted provider connection | 公开 |

### credential（15）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/credentials` | `listCredentials` | `bearerAuth` | List credential metadata for one owner | 公开 |
| `POST /api/v1/credentials` | `createCredential` | `bearerAuth` | Register a credential (requires credential_manage@credential:*) | 公开 |
| `POST /api/v1/credentials/precheck` | `precheckCredentialAtoms` | `bearerAuth` | Read-only pre-check of candidate atoms against the caller's grants | 公开 |
| `DELETE /api/v1/credentials/{id}` | `deleteCredential` | `bearerAuth` | Soft-delete a credential and return the reference report | 公开 |
| `POST /api/v1/credentials/{id}/bindings` | `bindCredentialToAgents` | `bearerAuth` | Bind the credential to Agent principals (all-or-nothing) | 公开 |
| `DELETE /api/v1/credentials/{id}/bindings` | `unbindCredentialFromAgents` | `bearerAuth` | Unbind the credential from Agent principals (all-or-nothing) | 公开 |
| `GET /api/v1/credentials/{id}/events` | `getCredentialEvents` | `bearerAuth` | Owner-visible credential audit trail (never a value) | 公开 |
| `GET /api/v1/credentials/{id}/references` | `getCredentialReferences` | `bearerAuth` | Reference report for one credential | 公开 |
| `POST /api/v1/credentials/{id}/replace` | `replaceCredentialSecret` | `bearerAuth` | 'Replace the secret value in place (credential_manage@credential:<id>)' | 公开 |
| `POST /api/v1/credentials/{id}/reveal` | `revealCredential` | `bearerAuth` | 'Reveal the plaintext — no-store delivery (repeatable reads) (credential_reveal@credential:<id> + s… | 公开 |
| `GET /api/v1/instance/credentials` | `listInstanceCredentials` | `bearerAuth` | List instance-owned credential metadata (instance admin) | 公开 |
| `POST /api/v1/instance/credentials` | `createInstanceCredential` | `bearerAuth` | Register an instance-owned credential (instance admin + credential_manage) | 公开 |
| `GET /api/v1/instance/credentials/{id}` | `getInstanceCredential` | `bearerAuth` | Read one instance-owned credential's metadata (instance admin) | 公开 |
| `DELETE /api/v1/instance/credentials/{id}` | `deleteInstanceCredential` | `bearerAuth` | Soft-delete an instance-owned credential and return the reference report | 公开 |
| `POST /api/v1/instance/credentials/{id}/reveal` | `revealInstanceCredential` | `bearerAuth` | 'Reveal an instance credential — no-store delivery (repeatable reads) (instance admin + credential_… | 公开 |

### mcp（12）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/instance/mcp` | `listInstanceMcpServers` | `bearerAuth` | Read the instance MCP server registry | 公开 |
| `POST /api/v1/instance/mcp` | `createInstanceMcpServer` | `bearerAuth` | Register one instance MCP server (instance admin only) | 公开 |
| `PATCH /api/v1/instance/mcp/{name}` | `updateInstanceMcpServer` | `bearerAuth` | Replace one instance MCP server entry (instance admin only) | 公开 |
| `DELETE /api/v1/instance/mcp/{name}` | `deleteInstanceMcpServer` | `bearerAuth` | Remove one instance MCP server from the registry (instance admin only) | 公开 |
| `GET /api/v1/mcp` | `mcpStream` | `bearerAuth` | Open the MCP event stream | 公开 |
| `POST /api/v1/mcp` | `mcpPost` | `bearerAuth` | MCP JSON-RPC endpoint (tools/list, tools/call, discovery) | 公开 |
| `DELETE /api/v1/mcp` | `mcpDisconnect` | `bearerAuth` | Disconnect the MCP stream | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/mcp-config` | `getMcpConfig` | `bearerAuth` | Get the MCP config of one workspace | 公开 |
| `PUT /api/v1/workspaces/{workspaceId}/mcp-config` | `putMcpConfig` | `bearerAuth` | Replace the MCP config of one workspace | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/mcp/servers` | `getWorkspaceMcpServers` | `bearerAuth` | List resolved MCP servers of one workspace | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/stdio-servers` | `getWorkspaceStdioServers` | `bearerAuth` | Get stdio server definitions of one workspace | 公开 |
| `PUT /api/v1/workspaces/{workspaceId}/stdio-servers` | `putWorkspaceStdioServers` | `bearerAuth` | Replace stdio server definitions of one workspace | 公开 |

### plugin（16）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/plugin-bindings` | `listPluginBindings` | `bearerAuth` | List the plugin bindings of the current workspace (PLAN-0691 T1.2) | 公开 |
| `POST /api/v1/plugin-bindings` | `createPluginBinding` | `bearerAuth` | Bind an installed plugin to the current workspace (PLAN-0691 T1.2) | 公开 |
| `GET /api/v1/plugin-bindings/{bindingId}` | `getPluginBinding` | `bearerAuth` | Read one binding of the current workspace (PLAN-0691 T1.2) | 公开 |
| `PATCH /api/v1/plugin-bindings/{bindingId}` | `updatePluginBinding` | `bearerAuth` | Change a binding''s state or granted atoms (PLAN-0691 T1.2) | 公开 |
| `DELETE /api/v1/plugin-bindings/{bindingId}` | `deletePluginBinding` | `bearerAuth` | Remove a binding from the workspace (PLAN-0691 T1.2) | 公开 |
| `GET /api/v1/plugin-bindings/{bindingId}/authorization` | `getPluginBindingAuthorization` | `bearerAuth` | Explain what a binding currently grants (PLAN-0691 T1.2) | 公开 |
| `GET /api/v1/plugins` | `listPlugins` | `bearerAuth` | List installed plugins (PLAN-0691 T1.1) | 公开 |
| `POST /api/v1/plugins/install` | `installPlugin` | `bearerAuth` | Install a plugin package (PLAN-0691 T1.1) | 公开 |
| `GET /api/v1/plugins/{pluginId}` | `getPlugin` | `bearerAuth` | Get one installed plugin (PLAN-0691 T1.1) | 公开 |
| `DELETE /api/v1/plugins/{pluginId}` | `uninstallPlugin` | `bearerAuth` | Uninstall a plugin (PLAN-0691 T1.1) | 公开 |
| `POST /api/v1/plugins/{pluginId}/disable` | `disablePlugin` | `bearerAuth` | Disable a plugin (PLAN-0691 T1.1) | 公开 |
| `POST /api/v1/plugins/{pluginId}/enable` | `enablePlugin` | `bearerAuth` | Enable a plugin (PLAN-0691 T1.1) | 公开 |
| `POST /api/v1/plugins/{pluginId}/upgrade` | `upgradePlugin` | `bearerAuth` | Upgrade a plugin to a newer version (PLAN-0691 T1.1) | 公开 |
| `GET /api/v1/sessions/{sessionId}/plugins` | `listSessionPlugins` | `bearerAuth` | List the plugin bindings attached to a session (PLAN-0691 T1.2) | 公开 |
| `POST /api/v1/sessions/{sessionId}/plugins` | `attachSessionPlugin` | `bearerAuth` | Attach a binding to a session (PLAN-0691 T1.2) | 公开 |
| `DELETE /api/v1/sessions/{sessionId}/plugins/{bindingId}` | `detachSessionPlugin` | `bearerAuth` | Detach a binding from a session (PLAN-0691 T1.2) | 公开 |

### skill（7）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/skill-bindings` | `createSkillBinding` | `bearerAuth` | Bind a skill to a subject at a scope (PLAN-0628 D28-14) | 公开 |
| `DELETE /api/v1/skill-bindings/{bindingId}` | `deleteSkillBinding` | `bearerAuth` | Remove one binding (PLAN-0628) | 公开 |
| `GET /api/v1/skills` | `listSkills` | `bearerAuth` | List the skill definitions the caller may see (PLAN-0628) | 公开 |
| `POST /api/v1/skills/import` | `importSkills` | `bearerAuth` | Import skill definitions (PLAN-0628 D28-17) | 公开 |
| `GET /api/v1/skills/{skillId}` | `getSkill` | `bearerAuth` | Read one skill definition (PLAN-0628) | 公开 |
| `DELETE /api/v1/skills/{skillId}` | `deleteSkill` | `bearerAuth` | Delete a skill definition and its bindings (PLAN-0628) | 公开 |
| `GET /api/v1/skills/{skillId}/bindings` | `listSkillBindings` | `bearerAuth` | List the bindings of one skill (PLAN-0628) | 公开 |

### rag（4）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `DELETE /api/v1/rag/documents/{docId}` | `ragDelete` | `bearerAuth` | Delete one document from the RAG index | 公开 |
| `POST /api/v1/rag/ingest` | `ragIngest` | `bearerAuth` | Ingest documents into the RAG index | 公开 |
| `POST /api/v1/rag/search` | `ragSearch` | `bearerAuth` | Search the RAG index | 公开 |
| `GET /api/v1/rag/stats` | `ragStats` | `bearerAuth` | Get RAG index statistics | 公开 |

### attachment（5）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/files/upload` | `uploadFile` | `bearerAuth` | Upload a workspace file | 公开 |
| `GET /api/v1/files/{fileId}` | `getFile` | `bearerAuth` | Get one workspace file | 公开 |
| `POST /api/v1/sessions/{sessionId}/attachments` | `uploadAttachments` | `bearerAuth` | Upload attachments to one session | 公开 |
| `GET /api/v1/sessions/{sessionId}/attachments/{fileId}` | `getAttachment` | `bearerAuth` | Get one session attachment | 公开 |
| `DELETE /api/v1/sessions/{sessionId}/attachments/{fileId}` | `deleteAttachment` | `bearerAuth` | Delete one session attachment | 公开 |

### job（11）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/workspaces/{workspaceId}/jobs` | `listWorkspaceJobs` | `bearerAuth` | List jobs of one workspace | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/jobs` | `startWorkspaceJob` | `bearerAuth` | Start a Workspace-scoped durable Job | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/jobs/{jobId}/cancel` | `cancelWorkspaceJob` | `bearerAuth` | Cancel one workspace job | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/jobs/{jobId}/output` | `getWorkspaceJobOutput` | `bearerAuth` | Get the output of one workspace job | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/scheduled-tasks` | `listScheduledTasks` | `bearerAuth` | List workspace scheduled tasks (PLAN-0489 T1.4) | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/scheduled-tasks` | `createScheduledTask` | `bearerAuth` | Create a scheduled task (human or agent principal, PLAN-0489 T1.4) | 公开 |
| `GET /api/v1/workspaces/{workspaceId}/scheduled-tasks/{taskId}` | `getScheduledTask` | `bearerAuth` | Read one scheduled task (PLAN-0489 T1.4) | 公开 |
| `DELETE /api/v1/workspaces/{workspaceId}/scheduled-tasks/{taskId}` | `deleteScheduledTask` | `bearerAuth` | Cancel a scheduled task (scheduled only; PLAN-0489 T1.4) | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/scheduled-tasks/{taskId}/postpone` | `postponeScheduledTask` | `bearerAuth` | Postpone a scheduled task to a future instant (PLAN-0489 T1.4) | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/scheduled-tasks/{taskId}/remove` | `removeScheduledTask` | `bearerAuth` | Remove a missed/expired scheduled task (idempotent, PLAN-0489 T1.4) | 公开 |
| `POST /api/v1/workspaces/{workspaceId}/scheduled-tasks/{taskId}/rerun` | `rerunScheduledTask` | `bearerAuth` | Rerun a missed/expired scheduled task once (PLAN-0489 T1.4) | 公开 |

### system（5）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /api/v1/health` | `health` | `public` | Liveness probe | 公开 |
| `POST /api/v1/logs` | `ingestLogs` | `bearerAuth` | Ingest a client-side log bundle | 公开 |
| `GET /api/v1/status` | `serviceStatus` | `bearerAuth` | Service status | 公开 |
| `POST /api/v1/telemetry/logs` | `ingestTelemetry` | `bearerAuth` | Ingest telemetry events | 公开 |
| `GET /api/v1/version` | `deploymentVersion` | `bearerAuth` | Deployment identity and module versions | 公开 |

## internal（100 operations · 服务间 · 3 tags）

### service-agent（30）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /internal/v1/agent/approval/pending` | `pendingApprovals` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/approval/respond` | `respondApproval` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/agent/approval/{requestId}` | `approvalStatus` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/chat` | `agentChat` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/checkpoints/lineages` | `createAgentCheckpointLineage` | `bearerAuth` | Create (or return) the CP-owned lineage for one LangGraph thread | 服务间 |
| `GET /internal/v1/agent/checkpoints/lineages/{threadId}` | `getAgentCheckpointLineage` | `bearerAuth` | Read one thread's lineage (owner-scoped) | 服务间 |
| `DELETE /internal/v1/agent/checkpoints/{threadId}` | `deleteAgentCheckpointThread` | `bearerAuth` | Delete one thread's checkpoint state for the given owner | 服务间 |
| `GET /internal/v1/agent/checkpoints/{threadId}/checkpoints` | `listAgentCheckpoints` | `bearerAuth` | List a thread's checkpoints (owner-scoped, newest first) | 服务间 |
| `PUT /internal/v1/agent/checkpoints/{threadId}/checkpoints` | `putAgentCheckpoint` | `bearerAuth` | Store one checkpoint (owner-scoped, idempotent by checkpointId) | 服务间 |
| `GET /internal/v1/agent/checkpoints/{threadId}/checkpoints/{checkpointId}` | `getAgentCheckpoint` | `bearerAuth` | Read one checkpoint (owner-scoped) | 服务间 |
| `POST /internal/v1/agent/checkpoints/{threadId}/writes` | `putAgentCheckpointWrites` | `bearerAuth` | Store pending writes for one checkpoint (owner-scoped) | 服务间 |
| `GET /internal/v1/agent/embedding-models` | `agentEmbeddingModels` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/agent/health` | `agentHealth` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/judge/decide` | `agentJudgeDecide` | `bearerAuth` | One judge completion for one CP-assembled prompt | 服务间 |
| `POST /internal/v1/agent/mcp/reinit` | `reinitializeAgentMcp` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/agent/models` | `agentModelsLegacy` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/models` | `agentScopedModels` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/rag/documents/{docId}/delete` | `agentRagDelete` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/rag/embedding/test` | `agentRagEmbeddingTest` | `bearerAuth` | Embedding provider probe behind the CP settings test action | 服务间 |
| `POST /internal/v1/agent/rag/ingest` | `agentRagIngest` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/rag/search` | `agentRagSearch` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/rag/stats` | `agentRagStats` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/agent/registry/workers` | `listWorkers` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/registry/workers/{workerId}/disable` | `disableWorker` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/registry/workers/{workerId}/enable` | `enableWorker` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/runs/{runId}/cancel` | `agentCancelRun` | `bearerAuth` | Ask the Agent to cancel one live run | 服务间 |
| `POST /internal/v1/agent/summarize` | `agentSummarize` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/agent/tools` | `agentTools` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/agent/user-question/respond` | `agentUserQuestionRespond` | `bearerAuth` | Deliver the user's answer to the Agent's blocked ask_user wait | 服务间 |
| `POST /internal/v1/agents/spawn` | `spawnAgentSession` | `bearerAuth` | Create an Agent spawn child Session from a durable parent run | 服务间 |

### service-runtime（38）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `POST /internal/v1/runtime/capabilities/direct-attach/probe` | `probeDirectAttachCapability` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/heartbeat` | `runtimeHeartbeat` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/remote-mcp/{workspaceId}/{serverId}/call` | `runtimeRemoteMcpCall` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces` | `registerRuntimeWorkspace` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/delete` | `deleteRuntimeWorkspace` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/runtime/workspaces/{workspaceId}/checkpoints/blob` | `runtimeCheckpointBlob` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/checkpoints/capture` | `runtimeCaptureCheckpointSlice` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/checkpoints/cleanup` | `runtimeCheckpointCleanup` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/checkpoints/gc` | `runtimeCheckpointGc` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/checkpoints/revert` | `runtimeCheckpointRevert` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/checkpoints/revert/preview` | `runtimeCheckpointRevertPreview` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/events` | `publishRuntimeWorkspaceEvent` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/runtime/workspaces/{workspaceId}/execution-spec` | `getWorkspaceExecutionSpec` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/executions/{toolCallId}/cancel` | `cancelRuntimeExecution` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/files/delete` | `runtimeDeleteFile` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/files/list` | `runtimeListFiles` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/files/mkdir` | `runtimeMkdir` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/files/read` | `runtimeReadFile` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/files/stat` | `runtimeStat` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/files/write/{path}` | `runtimeWriteFile` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/runtime/workspaces/{workspaceId}/git-diff` | `runtimeWorkspaceGitDiff` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/runtime/workspaces/{workspaceId}/git-facts` | `workspaceGitFacts` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/runtime/workspaces/{workspaceId}/git-log` | `runtimeWorkspaceGitLog` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/runtime/workspaces/{workspaceId}/git-status` | `runtimeWorkspaceGitStatus` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/jobs/cancel` | `cancelRuntimeWorkspaceJob` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/jobs/capabilities` | `runtimeWorkspaceJobCapabilities` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/jobs/cleanup` | `cleanupRuntimeWorkspaceJob` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/jobs/output` | `outputRuntimeWorkspaceJob` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/jobs/start` | `startRuntimeWorkspaceJob` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/jobs/status` | `statusRuntimeWorkspaceJob` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/materialize` | `triggerRuntimeWorkspaceMaterialize` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/mcp` | `runtimeMcp` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/runtime/workspaces/{workspaceId}/mcp/servers` | `listMcpSessions` | `bearerAuth` | — | 服务间 |
| `DELETE /internal/v1/runtime/workspaces/{workspaceId}/mcp/servers/{serverId}` | `stopMcpSession` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/mcp/spawn` | `spawnMcpSessionRetired` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/mcp/stdio/{serverId}` | `stdioMcp` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/runtime/workspaces/{workspaceId}/release` | `releaseRuntimeWorkspace` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/runtime/workspaces/{workspaceId}/status` | `getRuntimeWorkspaceStatus` | `bearerAuth` | — | 服务间 |

### service-misc（32）

| METHOD path | operationId | security | summary | 面 |
| --- | --- | --- | --- | --- |
| `GET /internal/v1/attachments/{attachmentId}/content` | `internalAttachmentContent` | `bearerAuth` | Stream one attachment's stored bytes to the Agent (internal, run-bound) | 服务间 |
| `GET /internal/v1/audit/entries/{type}/{id}` | `getInternalAuditEntryDetail` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/chat/runs/{runId}/guidance/pending` | `getPendingChatRunGuidance` | `bearerAuth` | Pending Guidance for the Agent runner at the tool-batch boundary | 服务间 |
| `POST /internal/v1/chat/runs/{runId}/guidance/{guidanceId}/consume` | `consumeChatRunGuidance` | `bearerAuth` | Acknowledge Guidance as injected into the next planning step | 服务间 |
| `GET /internal/v1/config/effective/{domain}` | `getEffectiveConfig` | `bearerAuth` | Resolve effective config for a domain (env > lock > workspace > user > instance > defaults); no lay… | 服务间 |
| `POST /internal/v1/context/{sessionId}/agents-md/resolve` | `resolveNestedAgentsMd` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/context/{sessionId}/compact` | `compactContext` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/context/{sessionId}/events` | `readContextEvents` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/context/{sessionId}/events` | `appendContextEvent` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/context/{sessionId}/events/batch` | `appendContextEvents` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/context/{sessionId}/events/latest` | `latestContextSequence` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/context/{sessionId}/refresh-sources` | `refreshContextSources` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/context/{sessionId}/replay` | `replayContext` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/context/{sessionId}/snapshot` | `contextSnapshot` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/context/{sourceSessionId}/fork` | `forkContext` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/credentials/rotation/runs` | `runCredentialRotationBatch` | `bearerAuth` | Re-encrypt one batch of credentials under the current key version | 服务间 |
| `GET /internal/v1/credentials/rotation/status` | `getCredentialRotationStatus` | `bearerAuth` | Credential key-ring rotation status | 服务间 |
| `POST /internal/v1/mcp/invocations/{invocationId}/late-termination` | `recordMcpInvocationLateTermination` | `bearerAuth` | — | 服务间 |
| `POST /internal/v1/oauth/token` | `brokerOAuthToken` | `bearerAuth` | — | 服务间 |
| `GET /internal/v1/plugin-bindings/{bindingId}/kv/{namespace}` | `listPluginKv` | `bearerAuth` | List a plugin KV namespace (PLAN-0691 T1.5 API-4) | 服务间 |
| `GET /internal/v1/plugin-bindings/{bindingId}/kv/{namespace}/{key}` | `readPluginKv` | `bearerAuth` | Read one plugin KV key (PLAN-0691 T1.5 API-1) | 服务间 |
| `PUT /internal/v1/plugin-bindings/{bindingId}/kv/{namespace}/{key}` | `writePluginKv` | `bearerAuth` | Write one plugin KV key with CAS (PLAN-0691 T1.5 API-2/API-9) | 服务间 |
| `DELETE /internal/v1/plugin-bindings/{bindingId}/kv/{namespace}/{key}` | `deletePluginKv` | `bearerAuth` | Delete one plugin KV key (PLAN-0691 T1.5 API-3/API-9) | 服务间 |
| `GET /internal/v1/plugin-bindings/{bindingId}/records/{collection}` | `listPluginRecords` | `bearerAuth` | Query one plugin records collection (PLAN-0691 T1.5 API-6/API-12) | 服务间 |
| `POST /internal/v1/plugin-bindings/{bindingId}/records/{collection}` | `createPluginRecord` | `bearerAuth` | Create one plugin record (PLAN-0691 T1.5 API-5) | 服务间 |
| `GET /internal/v1/plugin-bindings/{bindingId}/records/{collection}/{id}` | `readPluginRecord` | `bearerAuth` | Read one plugin record (PLAN-0691 T1.5 API-6) | 服务间 |
| `PUT /internal/v1/plugin-bindings/{bindingId}/records/{collection}/{id}` | `upsertPluginRecord` | `bearerAuth` | Upsert one plugin record (PLAN-0691 T1.5 API-5/API-10) | 服务间 |
| `DELETE /internal/v1/plugin-bindings/{bindingId}/records/{collection}/{id}` | `deletePluginRecord` | `bearerAuth` | Delete one plugin record (PLAN-0691 T1.5 API-7) | 服务间 |
| `POST /internal/v1/provider-leases/redeem` | `redeemProviderCredentialLease` | `bearerAuth` | Redeem a short-lived provider credential lease | 服务间 |
| `GET /internal/v1/queries/tier1/status` | `tier1ChainStatus` | `bearerAuth` | Tier-1 provenance-chain status metadata (grant-free, downward only) | 服务间 |
| `GET /internal/v1/queries/tier2/access` | `tier2ContentAccess` | `bearerAuth` | Tier-2 content access decision through the single grant kernel | 服务间 |
| `GET /internal/v1/workspaces/{workspaceId}/stdio-servers` | `getInternalWorkspaceStdioServers` | `bearerAuth` | — | 服务间 |
