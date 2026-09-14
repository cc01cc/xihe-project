package com.cc01cc.p.xihe.cp.policy;

import java.util.List;
import java.util.Optional;

/**
 * L0 hard guard: code-built protections that no mode or rule may override
 * (PLAN-0328 spec §13.1 / decision #17, #35, #55).
 *
 * <p>Each check declares whether it can be enforced <em>here</em> (gate side) or only by the
 * sandbox. Gate-side checks reject dispatch; sandbox-side checks are recorded so the caller can
 * surface them, but the real enforcement lives in the execution layer.</p>
 */
public class HardGuard {

    /** Guard kinds, mirroring spec §13.1. */
    public enum Kind {
        /** Path outside the workspace — gate can refuse dispatch. */
        PATH_ESCAPE(true),
        /** Sandbox escape / privilege escalation — enforced by the sandbox. */
        SANDBOX_ESCAPE(false),
        /** Credential exfiltration — sniffing can be done here, blocking is sandbox-side. */
        CREDENTIAL_EXFILTRATION(true),
        /** Approval object no longer matches the request (TOCTOU). */
        OBJECT_MISMATCH(true),
        /** Irreversible deletion of critical paths — refused at the gate. */
        CRITICAL_PATH_DELETION(true);

        private final boolean enforceableHere;

        Kind(boolean enforceableHere) {
            this.enforceableHere = enforceableHere;
        }

        public boolean enforceableHere() {
            return enforceableHere;
        }
    }

    public record HardDeny(Kind kind, String reason) {}

    /**
     * Critical path segments whose irreversible deletion is never allowed, regardless of mode.
     * Deliberately code-built and non-configurable.
     */
    private static final List<String> CRITICAL_SEGMENTS = List.of(
            "/.git", "\\.git", "/.xihe-shadow", "\\.xihe-shadow");

    /**
     * Credential-ish names that must not travel through tool arguments to untrusted destinations.
     * Only used to flag; blocking is the sandbox's job.
     */
    private static final List<String> CREDENTIAL_HINTS = List.of(
            "-----BEGIN", "AKIA", "ghp_", "sk-");

    public Optional<HardDeny> check(PolicyRequest request) {
        if (request == null) {
            return Optional.of(new HardDeny(Kind.OBJECT_MISMATCH, "empty request"));
        }
        for (String resource : request.resources()) {
            if (resource == null || resource.isBlank()) {
                continue;
            }
            String normalized = resource.replace('\\', '/').toLowerCase();
            if (normalized.contains("..") && normalized.contains("/")) {
                return Optional.of(new HardDeny(Kind.PATH_ESCAPE, "resource escapes workspace: " + resource));
            }
            for (String critical : CRITICAL_SEGMENTS) {
                if (normalized.contains(critical.replace('\\', '/').toLowerCase())) {
                    return Optional.of(new HardDeny(Kind.CRITICAL_PATH_DELETION,
                            "critical path is protected from irreversible deletion: " + resource));
                }
            }
            for (String hint : CREDENTIAL_HINTS) {
                if (resource.contains(hint)) {
                    return Optional.of(new HardDeny(Kind.CREDENTIAL_EXFILTRATION,
                            "credential-like material detected in arguments"));
                }
            }
        }
        return Optional.empty();
    }
}
