package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Acceptance ⑤ (D-1866 / task-24): naming a Session must not call any model or provider.
 *
 * <p>Behavioural tests can only show that no call happened <i>this time</i>. These two assertions
 * pin the shape instead: the deriver holds no collaborator to call, and neither class imports
 * anything from the provider/agent/LLM packages. Adding a model call therefore requires editing
 * this test's allow-list — a visible, reviewable act rather than a silent regression.
 */
class SessionTitleNoModelCallTest {

    private static final Path SOURCE_ROOT = locateSourceRoot();

    /** Packages that would make a model/provider call reachable. */
    private static final List<String> ALLOWED_IMPORT_PREFIXES = List.of(
            "java.",
            "com.cc01cc.p.xihe.cp.entity.",
            "org.slf4j.",
            "org.springframework.stereotype.");

    @Test
    void deriverHoldsNoCollaboratorAtAll() {
        for (Field field : SessionTitleDeriver.class.getDeclaredFields()) {
            assertTrue(Modifier.isStatic(field.getModifiers()),
                    "SessionTitleDeriver must not inject collaborators, found instance field "
                            + field.getName() + " : " + field.getType().getName());
        }
    }

    @Test
    void neitherClassImportsProviderAgentOrLlmPackages() {
        for (String fileName : List.of("SessionTitleRule.java", "SessionTitleDeriver.java")) {
            for (String importLine : importsOf(SOURCE_ROOT.resolve(fileName))) {
                assertFalse(isForbidden(importLine),
                        fileName + " must stay free of provider/agent/LLM dependencies: " + importLine);
            }
        }
    }

    private static boolean isForbidden(String importLine) {
        String target = importLine.replace("import static ", "").replace("import ", "").replace(";", "").strip();
        boolean allowed = ALLOWED_IMPORT_PREFIXES.stream().anyMatch(target::startsWith);
        return !allowed;
    }

    private static List<String> importsOf(Path source) {
        List<String> imports = new ArrayList<>();
        for (String line : read(source).split("\\R")) {
            String stripped = line.strip();
            if (stripped.startsWith("import ")) {
                imports.add(stripped);
            }
        }
        assertFalse(imports.isEmpty(), "no imports parsed from " + source);
        return imports;
    }

    private static String read(Path source) {
        try {
            return Files.readString(source, StandardCharsets.UTF_8);
        } catch (IOException cause) {
            throw new UncheckedIOException("cannot read " + source, cause);
        }
    }

    private static Path locateSourceRoot() {
        Path cursor = Path.of("").toAbsolutePath();
        for (int depth = 0; depth < 6 && cursor != null; depth++, cursor = cursor.getParent()) {
            Path candidate = cursor.resolve("src/main/java/com/cc01cc/p/xihe/cp/chat");
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException("CP chat source root not found above " + Path.of("").toAbsolutePath());
    }
}
