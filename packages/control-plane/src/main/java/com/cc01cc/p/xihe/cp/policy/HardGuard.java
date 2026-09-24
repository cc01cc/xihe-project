package com.cc01cc.p.xihe.cp.policy;

import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

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
     * Credential-like patterns precise enough to avoid flagging ordinary words (e.g. {@code task-notes}
     * or {@code risk-analysis}). Only used to flag; blocking is the sandbox's job.
     */
    private static final List<Pattern> CREDENTIAL_PATTERNS = List.of(
            Pattern.compile("-----BEGIN"),
            Pattern.compile("AKIA[0-9A-Z]{16}"),
            Pattern.compile("ghp_[A-Za-z0-9]{36}"),
            Pattern.compile("sk-[A-Za-z0-9_-]{20,}"));

    private static final Set<String> WORKSPACE_FILE_TOOLS = Set.of(
            "read_file", "read_file_range", "list_directory", "glob", "grep", "get_file_info",
            "watch_directory", "extract_pdf_text", "write_file", "edit_file", "delete_file",
            "delete_directory", "move_file", "copy_file", "mkdir", "apply_patch");

    /** Rejects explicit file resources that are not relative to the selected workspace root. */
    public Optional<HardDeny> checkWorkspaceResources(String toolName, List<String> resources) {
        if (PolicyResourceExtractor.hasInvalidResource(resources)) {
            return Optional.of(new HardDeny(Kind.PATH_ESCAPE, "resource scope could not be safely extracted"));
        }
        if (!WORKSPACE_FILE_TOOLS.contains(toolName) || resources == null) {
            return Optional.empty();
        }
        for (String resource : resources) {
            if (resource == null || resource.isBlank() || "*".equals(resource)) {
                if ("apply_patch".equals(toolName)) {
                    return Optional.of(new HardDeny(Kind.PATH_ESCAPE, "patch paths are required for workspace scope"));
                }
                continue;
            }
            String normalized = resource.replace('\\', '/');
            if (normalized.startsWith("/") || normalized.matches("^[A-Za-z]:.*")) {
                return Optional.of(new HardDeny(Kind.PATH_ESCAPE, "file resource must be workspace-relative"));
            }
            for (String segment : normalized.split("/", -1)) {
                if ("..".equals(segment)) {
                    return Optional.of(new HardDeny(Kind.PATH_ESCAPE, "file resource escapes workspace"));
                }
            }
        }
        return Optional.empty();
    }

    public Optional<HardDeny> check(PolicyRequest request) {
        if (request == null) {
            return Optional.of(new HardDeny(Kind.OBJECT_MISMATCH, "empty request"));
        }
        // Critical-path protection applies to deletions only: reading .git/.gitignore must not be denied
        boolean deletion = request.actionClasses().contains(ToolFaceRegistry.ACTION_DELETE);
        for (String resource : request.resources()) {
            if (resource == null || resource.isBlank()) {
                continue;
            }
            String normalized = resource.replace('\\', '/').toLowerCase();
            if (normalized.contains("..") && normalized.contains("/")) {
                return Optional.of(new HardDeny(Kind.PATH_ESCAPE, "resource escapes workspace: " + resource));
            }
            if (deletion) {
                for (String critical : CRITICAL_SEGMENTS) {
                    if (normalized.contains(critical.replace('\\', '/').toLowerCase())) {
                        return Optional.of(new HardDeny(Kind.CRITICAL_PATH_DELETION,
                                "critical path is protected from irreversible deletion: " + resource));
                    }
                }
            }
            for (Pattern pattern : CREDENTIAL_PATTERNS) {
                if (pattern.matcher(resource).find()) {
                    return Optional.of(new HardDeny(Kind.CREDENTIAL_EXFILTRATION,
                            "credential-like material detected in arguments"));
                }
            }
        }
        return Optional.empty();
    }
}
