package com.cc01cc.p.xihe.cp.support;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0646 MVP static gate: the thread seam decides visibility by scope ownership, never by role name,
 * instance-admin special-casing or capability string matching (the @PreAuthorize("isAuthenticated()")
 * gate is the only auth touch). Anything that reintroduces a privileged special case turns this red.
 */
class ThreadScopeResolutionScanTest {

    private static final List<String> FORBIDDEN = List.of(
            "isInstanceAdmin",
            "ROLE_",
            "hasRole(",
            "role.equals",
            "\"OWNER\"",
            "\"ADMIN\"",
            "workspace_role");

    @Test
    void threadResolutionReadsScopeOwnershipOnly() throws IOException {
        Path root = Path.of("src/main/java/com/cc01cc/p/xihe/cp");
        List<Path> candidates = new ArrayList<>();
        try (Stream<Path> files = Files.walk(root)) {
            files.filter(path -> path.getFileName().toString().endsWith(".java"))
                    .filter(path -> {
                        String name = path.getFileName().toString();
                        return name.startsWith("ConversationThread") || name.startsWith("ThreadAccess");
                    })
                    .forEach(candidates::add);
        }
        assertTrue(candidates.size() >= 3, "thread seam sources must be found: " + candidates);
        List<String> violations = new ArrayList<>();
        for (Path path : candidates) {
            String source = Files.readString(path, StandardCharsets.UTF_8);
            for (String token : FORBIDDEN) {
                if (source.contains(token)) {
                    violations.add(path.getFileName() + " contains " + token);
                }
            }
        }
        assertEquals(List.of(), violations, "thread visibility must not read role names: " + violations);
    }
}
