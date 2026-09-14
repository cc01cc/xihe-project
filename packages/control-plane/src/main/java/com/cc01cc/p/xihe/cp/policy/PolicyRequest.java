package com.cc01cc.p.xihe.cp.policy;

import java.util.List;
import java.util.Objects;

/**
 * One authorization request. See PLAN-0328 spec/approval.md §2.
 *
 * <p>{@code actionClasses} carries every domain the call touches (e.g. a move touches delete and
 * write); multi-domain verdicts combine as "any DENY wins, else any ASK, else ALLOW"
 * (spec §4.2 step 3).</p>
 */
public record PolicyRequest(
        String tool,
        List<String> actionClasses,
        List<String> resources,
        ToolShape shape,
        String userId,
        String workspaceId,
        String sessionId) {

    public PolicyRequest {
        Objects.requireNonNull(tool, "tool");
        actionClasses = List.copyOf(actionClasses == null || actionClasses.isEmpty()
                ? List.of(PolicyLayer.UNCLASSIFIED_ACTION)
                : actionClasses);
        resources = List.copyOf(resources == null ? List.of("*") : resources);
        shape = shape == null ? ToolShape.OPAQUE : shape;
    }

    public static PolicyRequest of(String tool, String actionClass) {
        return new PolicyRequest(tool, List.of(actionClass), List.of("*"), ToolShape.OPAQUE, null, null, null);
    }
}
