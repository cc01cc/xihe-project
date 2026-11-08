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
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0647 M3 / V5 static gate, <b>report-only</b> for the MVP (D-678 #4).
 *
 * <p>The pure-chat path must never resolve authority through the workspace-missing ⇒ instance
 * fallbacks. Existing hits are recorded as {@code 待修} and printed, not failed: the MVP only needs
 * the detector to exist, be deterministic and catch a synthetic probe. {@code ALLOWLIST} starts
 * <b>empty</b>; adding an entry is an explicit, reviewed act (a fix must not silently expand it).</p>
 */
class WorkspaceLessSessionScopeScanTest {

    private static final Path MAIN_SOURCES = Path.of("src/main/java/com/cc01cc/p/xihe/cp");

    /** Empty on purpose: the report lists every current hit; fixes land before entries appear here. */
    private static final Set<String> ALLOWLIST = Set.of();

    private static final Map<String, Pattern> FORBIDDEN_FORMS = new LinkedHashMap<>();

    static {
        FORBIDDEN_FORMS.put("access-scope-instance", Pattern.compile("AccessScope\\.instance\\s*\\(\\s*\\)"));
        FORBIDDEN_FORMS.put("instance-scope-constant", Pattern.compile("\\bINSTANCE_SCOPE\\b"));
        FORBIDDEN_FORMS.put("for-workspace", Pattern.compile("(?<!\\w)forWorkspace\\s*\\("));
        FORBIDDEN_FORMS.put("resolve-request-scope", Pattern.compile("\\bresolveRequestScope\\s*\\("));
        FORBIDDEN_FORMS.put("instance-admin-branch", Pattern.compile("\\bisInstanceAdmin\\b"));
        FORBIDDEN_FORMS.put("role-name-check", Pattern.compile("\\bhasRole\\s*\\(|\\bROLE_"));
        FORBIDDEN_FORMS.put("default-workspace-fallback", Pattern.compile(
                "\\b(firstActiveWorkspace|firstWorkspace|defaultWorkspace|orElseGet\\s*\\(\\s*\\(\\)\\s*->\\s*[^)]*[Ww]orkspace)"));
    }

    @Test
    void workspaceLessScopeForbiddenFormsAreReportedNotEnforced() throws IOException {
        List<String> hits = scan(MAIN_SOURCES);
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String hit : hits) {
            String form = hit.substring(hit.indexOf('[') + 1, hit.indexOf(']'));
            counts.merge(form, 1, Integer::sum);
        }
        System.out.println("[plan-0647] report-only instance-fallback scan: hits=" + hits.size() + " " + counts);
        hits.stream().limit(40).forEach(hit -> System.out.println("  " + hit));
        // report-only: existing hits are 待修, not a failure; empty allowlist is the contract.
        assertEquals(Set.of(), ALLOWLIST, "allowlist must start empty (D-678 #4)");
        // The detector must still see the known anchor (otherwise the gate silently rotted).
        assertTrue(hits.stream().anyMatch(hit -> hit.contains("policy/AccessScopeResolver.java")),
                "detector must report the known AccessScopeResolver fallback: " + hits);
    }

    @Test
    void detectorCatchesSyntheticForbiddenForms() {
        List<String> hits = scanSource("synthetic/Probe.java", String.join("\n",
                "AccessScope.instance();",
                "return AccessScope.INSTANCE_SCOPE;",
                "scope = AccessScope.forWorkspace(workspaceId);",
                "resolver.resolveRequestScope(request);",
                "if (auth.isInstanceAdmin(user)) { return true; }",
                "if (hasRole(\"OWNER\")) { return true; }",
                "return Optional.ofNullable(ws).orElseGet(() -> defaultWorkspace);"));
        for (String form : FORBIDDEN_FORMS.keySet()) {
            String expected = "[" + form + "]";
            assertTrue(hits.stream().anyMatch(hit -> hit.contains(expected)),
                    "detector missed " + form + ": " + hits);
        }
        assertFalse(hits.isEmpty(), "synthetic probe must produce hits");
    }

    private static List<String> scan(Path root) throws IOException {
        List<String> hits = new ArrayList<>();
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
                String relative = MAIN_SOURCES.relativize(file).toString().replace('\\', '/');
                hits.addAll(scanSource(relative, Files.readString(file, StandardCharsets.UTF_8)));
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
                if (pattern.matcher(lines[index]).find()) {
                    hits.add(relative + ":" + (index + 1) + " [" + form + "] " + lines[index].trim());
                }
            }
        }
        return hits;
    }
}
