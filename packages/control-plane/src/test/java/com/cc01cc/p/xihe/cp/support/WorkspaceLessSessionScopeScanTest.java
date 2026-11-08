package com.cc01cc.p.xihe.cp.support;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0647 M3 / V5 + PLAN-0704 M0 static gate.
 *
 * <p><b>Pure-chat scope:</b> the workspace-less session path must never resolve authority through
 * an instance-scope fallback or a role-name special case. This gate scans only the conversation
 * surface ({@code chat/} and {@code service/}); the policy/binding-admin files that legitimately
 * use {@code AccessScope.instance()} are audited and allowlisted line-by-line (D-711: 7 files).</p>
 *
 * <p><b>Enforced (PLAN-0704 M0):</b> any hit outside the audited allowlist fails. Comments are
 * stripped first so a {@code // ROLE_ADMIN ...} explanation cannot trip the gate, and the detector
 * still has a synthetic self-test that proves every forbidden form is caught.</p>
 */
class WorkspaceLessSessionScopeScanTest {

    private static final Path MAIN_SOURCES = Path.of("src/main/java/com/cc01cc/p/xihe/cp");

    /** Conversation surface only; policy/ holds the audited management faces. */
    private static final List<Path> SCAN_ROOTS = List.of(
            MAIN_SOURCES.resolve("chat"),
            MAIN_SOURCES.resolve("service"));

    /**
     * Audited legal instance-management faces (D-711). Each entry is an explicit, reviewed
     * exception: these services administer instance-scoped bindings/roles and never serve the
     * pure-chat request path. Do not add a file here to silence a regression.
     */
    private static final Map<String, String> ALLOWLIST = new LinkedHashMap<>();

    static {
        ALLOWLIST.put("service/AgentPrincipalService.java",
                "instance-scope agent-principal admin: grants/role materialization for admin faces");
        ALLOWLIST.put("service/AgentPrincipalSkillBindingService.java",
                "instance-scope skill binding administration (admin face, not chat path)");
        ALLOWLIST.put("service/AgentPrincipalRoleBindingService.java",
                "instance-scope role binding administration (admin face, not chat path)");
        ALLOWLIST.put("policy/AccessScopeResolver.java",
                "resolves the scope of an authenticated request; instance is the explicit fallback axis");
        ALLOWLIST.put("policy/BindingAdminService.java",
                "instance binding administration: manages instance-scope grants");
        ALLOWLIST.put("policy/RoleAdminService.java",
                "instance role administration: manages instance-scope roles");
        ALLOWLIST.put("policy/RoleGrantMaterializer.java",
                "materializes instance-scope grants for the role/binding admin faces");
    }

    private static final Map<String, Pattern> FORBIDDEN_FORMS = new LinkedHashMap<>();

    static {
        FORBIDDEN_FORMS.put("access-scope-instance", Pattern.compile("AccessScope\\.instance\\s*\\(\\s*\\)"));
        FORBIDDEN_FORMS.put("instance-scope-constant", Pattern.compile("\\bINSTANCE_SCOPE\\b"));
        FORBIDDEN_FORMS.put("instance-admin-branch", Pattern.compile("\\bisInstanceAdmin\\b"));
        FORBIDDEN_FORMS.put("role-admin-check",
                Pattern.compile("\\bROLE_ADMIN\\b|\\bhasRole\\s*\\(\\s*[\"']ADMIN"));
    }

    @Test
    void workspaceLessPathHasNoInstanceOrRoleAdminFallback() throws IOException {
        List<String> hits = scan(SCAN_ROOTS);
        System.out.println("[plan-0704] enforced instance-fallback scan: hits=" + hits.size()
                + " allowlisted=" + ALLOWLIST.size());
        hits.forEach(hit -> System.out.println("  " + hit));

        List<String> violations = hits.stream()
                .filter(hit -> ALLOWLIST.keySet().stream().noneMatch(hit::startsWith))
                .toList();
        assertEquals(List.of(), violations,
                "pure-chat path must not use instance-scope/role-admin fallbacks: " + violations);
        // The chat package itself must stay completely clean (V1): no allowlisted hits are in chat/.
        assertTrue(hits.stream().noneMatch(hit -> hit.startsWith("chat/")),
                "chat/ must have zero forbidden forms: " + hits);
        assertEquals(7, ALLOWLIST.size(), "allowlist is exactly the audited 7 files (D-711)");
        assertTrue(ALLOWLIST.values().stream().noneMatch(String::isBlank),
                "every allowlist entry needs a line-level reason");
    }

    @Test
    void detectorCatchesSyntheticForbiddenForms() {
        List<String> hits = scanSource("synthetic/Probe.java", String.join("\n",
                "AccessScope.instance();",
                "return AccessScope.INSTANCE_SCOPE;",
                "if (auth.isInstanceAdmin(user)) { return true; }",
                "if (hasRole(\"ADMIN\")) { return true; }",
                "if (\"ROLE_ADMIN\".equals(role)) { return true; }"));
        for (String form : FORBIDDEN_FORMS.keySet()) {
            String expected = "[" + form + "]";
            assertTrue(hits.stream().anyMatch(hit -> hit.contains(expected)),
                    "detector missed " + form + ": " + hits);
        }
        assertFalse(hits.isEmpty(), "synthetic probe must produce hits");
    }

    private static List<String> scan(List<Path> roots) throws IOException {
        List<String> hits = new ArrayList<>();
        for (Path root : roots) {
            try (Stream<Path> files = Files.walk(root)) {
                for (Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
                    String relative = MAIN_SOURCES.relativize(file).toString().replace('\\', '/');
                    hits.addAll(scanSource(relative, Files.readString(file, StandardCharsets.UTF_8)));
                }
            }
        }
        return hits;
    }

    private static List<String> scanSource(String relative, String source) {
        List<String> hits = new ArrayList<>();
        String[] lines = source.split("\\n", -1);
        for (String form : FORBIDDEN_FORMS.keySet()) {
            Pattern pattern = FORBIDDEN_FORMS.get(form);
            for (int index = 0; index < lines.length; index++) {
                String line = stripComment(lines[index]);
                if (!line.isBlank() && pattern.matcher(line).find()) {
                    hits.add(relative + ":" + (index + 1) + " [" + form + "] " + line.trim());
                }
            }
        }
        return hits;
    }

    /** Remove line/block-comment prose (good comments must not turn a regression gate red). */
    private static String stripComment(String line) {
        int lineComment = line.indexOf("//");
        if (lineComment >= 0) {
            return line.substring(0, lineComment);
        }
        String trimmed = line.trim();
        if (trimmed.startsWith("/*") || trimmed.startsWith("*")) {
            return "";
        }
        return line;
    }
}
