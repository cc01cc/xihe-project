package com.cc01cc.p.xihe.cp.policy;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * task-556: the atom vocabulary size is stated as prose in three places. All three drifted and
 * disagreed with each other (17 / 18 = 15+3 / 31 = 28+3) while the real vocabulary was 40 = 37+3
 * — a reader who opened the catalog read 31 and got 40.
 *
 * <p>This gate closes that class: the expected numbers are <b>computed from the atom collections</b>
 * (never hardcoded, D-1409), and each prose site is asserted against the computed values, so a
 * mutation in any single site fails at that site's assertion.</p>
 */
class PolicyVocabularyCountProseTest {

    private static final int EXPECTED_CAPABILITY_ATOMS = 3;

    private static final Pattern CATALOG_HEADER =
            Pattern.compile("Action atoms \\((\\d+)\\)");
    private static final Pattern ROLE_CONTROLLER =
            Pattern.compile("(\\d+) atoms \\((\\d+) action \\+ (\\d+) capability\\)");
    private static final Pattern ACTION_ACCESSOR =
            Pattern.compile("The action atoms, in canonical order \\((\\d+)\\)\\.?");
    private static final Pattern OPENAPI =
            Pattern.compile("(\\d+) atoms = (\\d+) action atoms \\+ (\\d+) capability");

    private static Path moduleRoot() {
        // Surefire runs with the module base directory as the working directory.
        return Path.of("");
    }

    private static int actionAtoms() {
        return PermissionAtomCatalog.actionAtoms().size();
    }

    private static int capabilityAtoms() {
        return PermissionAtomCatalog.capabilityAtoms().size();
    }

    private static String read(String relative) throws IOException {
        Path path = moduleRoot().resolve(relative);
        assertThat(Files.exists(path)).as("gate fixture missing: %s", relative).isTrue();
        return Files.readString(path, StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("capability atom count is the documented 3 (anchor for the derived totals)")
    void capabilityAtomCountIsAnchored() {
        assertThat(capabilityAtoms()).isEqualTo(EXPECTED_CAPABILITY_ATOMS);
    }

    @Test
    @DisplayName("PermissionAtomCatalog header states the computed action-atom count")
    void catalogHeaderMatchesComputedCount() throws IOException {
        String src = read("src/main/java/com/cc01cc/p/xihe/cp/policy/PermissionAtomCatalog.java");
        Matcher m = CATALOG_HEADER.matcher(src);
        assertThat(m.find()).as("header must state 'Action atoms (N)'").isTrue();
        assertThat(m.group(1))
                .as("PermissionAtomCatalog header action-atom count")
                .isEqualTo(String.valueOf(actionAtoms()));
    }

    @Test
    @DisplayName("actionAtoms() javadoc states the computed action-atom count")
    void actionAccessorJavadocMatchesComputedCount() throws IOException {
        String src = read("src/main/java/com/cc01cc/p/xihe/cp/policy/PermissionAtomCatalog.java");
        Matcher m = ACTION_ACCESSOR.matcher(src);
        assertThat(m.find()).as("actionAtoms() javadoc must state 'in canonical order (N)'").isTrue();
        assertThat(m.group(1))
                .as("actionAtoms() javadoc action-atom count")
                .isEqualTo(String.valueOf(actionAtoms()));
    }

    @Test
    @DisplayName("RoleController route javadoc states the computed totals")
    void roleControllerJavadocMatchesComputedCount() throws IOException {
        String src = read("src/main/java/com/cc01cc/p/xihe/cp/policy/RoleController.java");
        Matcher m = ROLE_CONTROLLER.matcher(src);
        assertThat(m.find()).as("javadoc must state 'N atoms (M action + K capability)'").isTrue();
        assertThat(m.group(1))
                .as("RoleController total atom count")
                .isEqualTo(String.valueOf(actionAtoms() + capabilityAtoms()));
        assertThat(m.group(2))
                .as("RoleController action-atom count")
                .isEqualTo(String.valueOf(actionAtoms()));
        assertThat(m.group(3))
                .as("RoleController capability-atom count")
                .isEqualTo(String.valueOf(capabilityAtoms()));
    }

    @Test
    @DisplayName("openapi role-catalog description states the computed totals")
    void openapiCatalogDescriptionMatchesComputedCount() throws IOException {
        String yaml = read(Path.of("..", "..", "docs", "api", "openapi.yaml").toString());
        Matcher m = OPENAPI.matcher(yaml);
        assertThat(m.find()).as("openapi must state 'N atoms = M action atoms + K capability atoms'").isTrue();
        assertThat(m.group(1))
                .as("openapi total atom count")
                .isEqualTo(String.valueOf(actionAtoms() + capabilityAtoms()));
        assertThat(m.group(2))
                .as("openapi action-atom count")
                .isEqualTo(String.valueOf(actionAtoms()));
        assertThat(m.group(3))
                .as("openapi capability-atom count")
                .isEqualTo(String.valueOf(capabilityAtoms()));
    }
}
