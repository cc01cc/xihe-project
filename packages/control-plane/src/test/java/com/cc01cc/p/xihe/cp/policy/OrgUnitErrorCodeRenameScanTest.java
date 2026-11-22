package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * task-838: the org-unit governance refusal is a <b>preset</b> judgement, so the retired role-scoped
 * spelling of the refusal code (and its response component) must be gone. This is the
 * reverse half of the rename: a positive assertion somewhere else cannot prove the old string
 * never lingers next to it, and a stale copy in a description is exactly what a client would read.
 *
 * <p>The scan is scoped to this module's sources plus {@code docs/api/openapi.yaml} — the card's
 * write surface. {@code packages/ui} and {@code docs/i18n} are owned by other lanes; their copies
 * are reported by task-838 rather than edited here.</p>
 */
class OrgUnitErrorCodeRenameScanTest {

    /** Split so this test file never matches its own needle. */
    private static final String RETIRED_CODE = "ORG_SCOPE_" + "ROLE_FORBIDDEN";
    private static final String RETIRED_RESPONSE = "OrgScope" + "RoleForbidden";

    @Test
    void constantCarriesThePresetSpelling() {
        assertEquals("ORG_SCOPE_PRESET_FORBIDDEN", OrgUnitGovernancePolicy.CODE_FORBIDDEN,
                "the refusal code is the preset spelling, with no alias kept behind");
    }

    @Test
    void retiredSpellingNoLongerAppears() throws IOException {
        List<String> hits = new ArrayList<>();
        for (Path root : List.of(Path.of("src", "main", "java"), Path.of("src", "test", "java"))) {
            hits.addAll(scanTree(root));
        }
        hits.addAll(scanFile(Path.of("..", "..", "docs", "api", "openapi.yaml")));
        assertTrue(hits.isEmpty(), () -> "retired code/response spelling still present: " + hits);
    }

    private static List<String> scanTree(Path root) throws IOException {
        List<String> hits = new ArrayList<>();
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : files.filter(Files::isRegularFile).sorted().toList()) {
                hits.addAll(scanFile(file));
            }
        }
        return hits;
    }

    private static List<String> scanFile(Path file) throws IOException {
        List<String> hits = new ArrayList<>();
        List<String> lines = Files.readAllLines(file);
        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            if (line.contains(RETIRED_CODE) || line.contains(RETIRED_RESPONSE)) {
                hits.add(file + ":" + (i + 1));
            }
        }
        return hits;
    }
}
