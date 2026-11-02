package com.cc01cc.p.xihe.cp.policy;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.UUID;

/**
 * PLAN-0625 M2: one hook evaluation context. Records are immutable so advisors cannot smuggle
 * mutable request state between the gate and the (async) evaluation.
 *
 * @param actionClass the frozen action-class vocabulary value (D25-12, exact match — no globs)
 * @param payload     action-specific canonical JSON (e.g. {@code requestId}/{@code tool}/
 *                    {@code action} for {@code approval.ask}); never carries secrets
 * @param sessionId   the session the action belongs to
 * @param runId       the run the action belongs to, or null when not run-scoped
 * @param participantId the responding participant, or null when participant-agnostic
 * @param workspaceId the workspace the action is scoped to
 */
public record HookInvocation(String actionClass, JsonNode payload,
                             UUID sessionId, UUID runId, UUID participantId, UUID workspaceId) {
}
