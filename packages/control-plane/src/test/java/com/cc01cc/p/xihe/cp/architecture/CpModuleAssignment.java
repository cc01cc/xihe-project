package com.cc01cc.p.xihe.cp.architecture;

import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.library.dependencies.SliceAssignment;
import com.tngtech.archunit.library.dependencies.SliceIdentifier;

import java.util.Set;

final class CpModuleAssignment implements SliceAssignment {

    private static final String ROOT = "com.cc01cc.p.xihe.cp";
    private static final Set<String> MIXED = Set.of("controller", "service", "entity", "repository");

    String ownerOf(JavaClass type) {
        if (type.isArray()) {
            type = type.getBaseComponentType();
        }
        String packageName = type.getPackageName();
        if (packageName.equals(ROOT)) {
            return "bootstrap";
        }
        if (!packageName.startsWith(ROOT + ".")) {
            return null;
        }
        String localPackage = packageName.substring(ROOT.length() + 1);
        String top = localPackage.split("\\.", 2)[0];
        if (!MIXED.contains(top)) {
            return top;
        }
        String name = type.getName().substring(packageName.length() + 1).split("\\$", 2)[0];
        if (name.startsWith("WorkspaceJob")) {
            return "operation";
        }
        if (name.startsWith("WorkspaceImport")) {
            return "importjob";
        }
        if (name.startsWith("WorkspaceEvent")) {
            return "event";
        }
        if (name.startsWith("Workspace")) {
            return "workspace";
        }
        // PLAN-0641 T5.1: the legacy-slice declaration boundary is a pure helper of the workspace/root
        // slice (workspace_roots.created_at vs run_checkpoints.captured_at). Without this assignment
        // ArchUnit's import throws before any rule runs — the whole class was dead (BL-370, L2 2026-11-06).
        if (name.startsWith("LegacySlice")) {
            return "workspace";
        }
        if (name.startsWith("Agent")) {
            return "principal";
        }
        // PLAN-0629 M1-6: the passive-write seam (`PassiveMemoryJudge`) lives in `cp.service` but
        // belongs to the agent-memory feature, whose whole family (`AgentMemory*`) resolves to the
        // `principal` slice above — the judge only decides whether an already-produced summary is
        // worth remembering, and both its caller (`AgentMemoryPassiveWriter`) and its consumer are
        // memory types. Leaving it unassigned made `CpArchitectureTest` error out (L2, 2026-11-03).
        if (name.equals("PassiveMemoryJudge")) {
            return "principal";
        }
        if (name.startsWith("ContextTemplate")) {
            return "context";
        }
        if (name.startsWith("Runtime")) {
            return "runtime";
        }
        if (name.startsWith("RunCheckpoint")) {
            return "checkpoint";
        }
        if (name.startsWith("RunTrace")) {
            return "chat";
        }
        if (name.startsWith("Mcp")) {
            return "mcp";
        }
        if (name.startsWith("Provider")) {
            return "provider";
        }
        if (name.startsWith("ApiRequestTemplate") || name.startsWith("ApiInputType")) {
            return "provider";
        }
        if (name.startsWith("OAuth")) {
            return "oauth";
        }
        // PLAN-0772/task-165: the instance credential face (controller + admin service) is the same
        // capability family as the workspace credential slice; the prefix is "InstanceCredential", not
        // "Credential", so it needs its own registration instead of silently landing in another slice.
        if (name.startsWith("InstanceCredential")) {
            return "credentials";
        }
        if (name.startsWith("Credential")) {
            return "credentials";
        }
        if (name.startsWith("Policy") || name.startsWith("ToolFace") || name.startsWith("AuthorizationGrant")) {
            return "policy";
        }
        // PLAN-0625 M2 (D25-15): the hook seam — interface, registry, verdict and cache — lives in the
        // policy package, so its implementations follow the family even when they sit in `service`.
        // `GuardHookAdvisor` is the guard's `HookAdvisor`, not a module of its own (the session-facing
        // advice trigger stays in chat: `chat.GuardAdviceService`).
        if (name.startsWith("Hook") || name.equals("GuardHookAdvisor")) {
            return "policy";
        }
        // PLAN-0610: the dynamic RBAC slice (roles / role_permissions / role_bindings) is part of the
        // authorization surface, so its entities, repositories and admin services belong to "policy"
        // rather than growing a new module for one capability family. MemberView is the public
        // projection of workspace membership (PLAN-0565), so it stays with the workspace slice.
        if (name.startsWith("AccessRole") || name.startsWith("RoleAdmin") || name.startsWith("RoleController")
                || name.startsWith("RoleGrantMaterializer") || name.startsWith("SystemAccessRole")
                || name.startsWith("MePermissions")) {
            return "policy";
        }
        if (name.equals("MemberView")) {
            return "workspace";
        }
        // PLAN-0470: the Context EventStore/projection family (entities, repositories and services)
        // is its own slice; without this the classification gate cannot even import the model.
        if (name.startsWith("Context") || name.startsWith("EventStore") || name.equals("CompactionNoticePort")) {
            return "context";
        }
        if (name.startsWith("Config") || name.equals("ImportService") || name.equals("ExportService")) {
            return "config";
        }
        if (name.startsWith("File")) {
            return "files";
        }
        if (name.startsWith("User")) {
            return "auth";
        }
        // PLAN-0580: the instance-owner pointer lives with the role/identity
        // surface it guards (users.role, users.token_version), so it belongs to the
        // same slice instead of introducing a new module for one singleton row.
        if (name.startsWith("InstanceOwner")) {
            return "auth";
        }
        // PLAN-0767 M1: the deployment identity singleton (entity/repository/service/controller)
        // sits on the same instance-level identity surface as the owner pointer; consumers
        // (provider, config) point at it and it points only at audit/telemetry, so no new slice.
        // PLAN-0772/task-165: the instance-level agent-principal admin face is the same capability
        // family as the Agent* surface (principal), but the "Instance" prefix keeps it out of that rule.
        if (name.startsWith("InstanceAgentPrincipal")) {
            return "principal";
        }
        if (name.startsWith("InstanceIdentity")) {
            return "auth";
        }
        if (name.startsWith("AuditLog")) {
            return "audit";
        }
        if (name.equals("UuidStringConverter")) {
            return "persistence";
        }
        // PLAN-0624: the wake chain is the conversation pipeline's wake path, so it belongs to the same
        // slice as the chat-package `WakeChain*` / `WakeFanOut*` types; the judge family and the
        // participant-level capability resolution are part of that same path — the judge decides
        // whether a participant speaks in a wake round, and `judge_decisions` is only consumed by the
        // wake dispatcher and the hook advisors. Session participants already resolve to chat through
        // the `Session` prefix.
        if (name.startsWith("Wake") || name.startsWith("Judge") || name.startsWith("Participant")) {
            return "chat";
        }
        if (name.startsWith("Session") || name.startsWith("Chat") || name.startsWith("Approval")
                || name.startsWith("Message") || name.startsWith("Inbox") || name.startsWith("Task")
                || name.equals("BranchPathService") || name.equals("RootBranchBinder")) {
            return "chat";
        }
        // PLAN-0646 MVP: the conversation-thread seam (entity/repository/service live in the mixed
        // packages) belongs to the chat/session pipeline; its nested AttachResult is covered because
        // the name is split at '$' above; without this ArchUnit aborts at import ("unassigned type").
        if (name.startsWith("ConversationThread") || name.startsWith("ThreadAccess")) {
            return "chat";
        }
        throw new IllegalArgumentException("Unassigned mixed-package production type: " + type.getName());
    }

    @Override
    public SliceIdentifier getIdentifierOf(JavaClass type) {
        String owner = ownerOf(type);
        return owner == null ? SliceIdentifier.ignore() : SliceIdentifier.of(owner);
    }

    @Override
    public String getDescription() { return "the frozen CP capability ownership matrix"; }
}
