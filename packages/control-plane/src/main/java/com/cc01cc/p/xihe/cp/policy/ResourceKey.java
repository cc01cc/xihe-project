package com.cc01cc.p.xihe.cp.policy;

/**
 * PLAN-0622 M1.5 (design §3.1): one resource identity for the unified governor.
 *
 * <p>{@code kind} is the resource class; {@code scope} is the concrete key inside that class
 * (for example {@code connection:<uuid>} or {@code connection:<uuid>/<provider>/<model>}).
 * A session-scoped key is rejected on construction: the session is a UX container, never a
 * concurrency limit (design decision "资源限额不挂会话"; checklist V8).</p>
 */
public record ResourceKey(Kind kind, String scope) {

    /** The six resource classes of the unified governor (design §3.1). */
    public enum Kind {
        CONNECTION,
        MODEL,
        FILE_WRITE,
        PROCESS,
        JOB,
        MCP
    }

    public ResourceKey {
        if (kind == null) {
            throw new IllegalArgumentException("Resource kind is required");
        }
        if (scope == null || scope.isBlank()) {
            throw new IllegalArgumentException("Resource scope is required");
        }
        if (scope.startsWith("session:") || scope.contains("/session:")) {
            throw new IllegalArgumentException("Session-scoped resource keys are not allowed");
        }
    }

    public static ResourceKey connection(String connectionId) {
        return new ResourceKey(Kind.CONNECTION, "connection:" + connectionId);
    }

    public static ResourceKey model(String connectionId, String provider, String model) {
        return new ResourceKey(Kind.MODEL, "connection:" + connectionId + "/" + provider + "/" + model);
    }
}
