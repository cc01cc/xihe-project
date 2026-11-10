package com.cc01cc.p.xihe.cp.api;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.error.Mark;
import org.yaml.snakeyaml.nodes.MappingNode;
import org.yaml.snakeyaml.nodes.Node;
import org.yaml.snakeyaml.nodes.NodeTuple;
import org.yaml.snakeyaml.nodes.ScalarNode;
import org.yaml.snakeyaml.nodes.SequenceNode;

import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-246: {@code docs/api/openapi.yaml} must not contain duplicate mapping keys.
 *
 * <p>Why this exists: {@code mise run check:openapi} (BL-162) reuses <b>oxfmt</b> as its YAML
 * syntax parser (BL-451), and oxfmt accepts duplicate keys — so two duplicated keys lived in the
 * contract undetected until redocly refused to parse it and a {@code yaml.compose()} sweep found
 * them (2026-11-10). YAML semantics are <b>last key wins</b>, so a duplicate silently deletes the
 * earlier block; in {@code ChatRunSkillsSnapshotTier} that produced a schema whose {@code required}
 * + {@code additionalProperties: false} contradicted the surviving {@code properties}.</p>
 *
 * <p>Where it runs: this is a plain JUnit test in the existing {@code test:cp} wave — it needs no
 * Spring context, no Maven plugin, no new dependency (SnakeYAML already ships with Spring Boot and
 * is already used by {@link RouteContractParityTest} to read the same file). Cost is one extra
 * compose of a 1.3 MB file.</p>
 *
 * <p>Why not {@code check:openapi}: that gate is plain Node and the repo declares <b>no</b> YAML
 * parser for it (oxfmt only checks syntax). Wiring it there would either add an npm dependency or
 * bind a Node gate to the agent Python venv — both rejected in the card's option analysis.</p>
 *
 * <p><b>Baseline semantics (only-shrinks):</b> the two duplicates known at the time of writing are
 * frozen in {@link #KNOWN_DUPLICATES}. The assertion is {@code findings ⊆ baseline}: a <b>new</b>
 * duplicate fails immediately; a baseline entry that no longer reproduces is reported as stale so
 * it gets deleted (deleting is safe: the file then has fewer duplicates, never more).</p>
 */
class OpenApiDuplicateKeyTest {

    /**
     * BL-320's sibling pattern: frozen, delete-on-fix, never grow.
     *
     * <p>Both entries are real defects still present on this branch (measured 2026-11-10 with this
     * detector); task-236 fixes them in `openapi.yaml`. <b>When that lands, delete the matching
     * line here in the same merge</b> — the test fails with "entries no longer reproduce" otherwise,
     * which is the point: the baseline may only shrink.</p>
     */
    private static final List<String> KNOWN_DUPLICATES = List.of(
            // /api/v1/chat POST: two '503' response keys (BACKEND_DISABLED description is dropped by YAML last-wins)
            "paths./api/v1/chat.post.responses.503",
            // ChatRunSkillsSnapshotTier: two 'properties' keys (surviving set contradicts required + additionalProperties:false)
            "components.schemas.ChatRunSkillsSnapshotTier.properties");

    private static final Path CONTRACT = Path.of("..", "..", "docs", "api", "openapi.yaml");

    @Test
    void contractHasNoUnknownDuplicateKeys() throws IOException {
        List<Finding> findings = scan(Files.readString(CONTRACT, StandardCharsets.UTF_8));

        System.out.println("[task-246] duplicate-key findings=" + findings.size());
        for (Finding f : findings) {
            System.out.println("[task-246]   " + f.path + " at " + f.line + ":" + f.column
                    + " (first occurrence line " + f.firstLine + ")");
        }

        List<String> unexpected = findings.stream()
                .map(f -> f.path)
                .filter(p -> !KNOWN_DUPLICATES.contains(p))
                .toList();
        assertEquals(List.of(), unexpected,
                () -> "docs/api/openapi.yaml has duplicate mapping keys (YAML keeps the LAST one, so the "
                        + "earlier block is silently dropped). Fix the contract; do not grow the baseline:\n  "
                        + String.join("\n  ", unexpected));

        List<String> stale = KNOWN_DUPLICATES.stream()
                .filter(k -> findings.stream().noneMatch(f -> f.path.equals(k)))
                .toList();
        assertTrue(stale.isEmpty(),
                () -> "KNOWN_DUPLICATES entries no longer reproduce — delete them from the baseline "
                        + "(this list only shrinks):\n  " + String.join("\n  ", stale));
    }

    /** Negative fixture: the exact shape that shipped twice (two '503' response keys). */
    @Test
    void detectsDuplicateKeyAndReportsLine(@TempDir Path tmp) throws IOException {
        String yaml = String.join("\n",
                "paths:",
                "  /a:",
                "    post:",
                "      responses:",
                "        '400': { description: bad }",
                "        '503': { description: first }",
                "        '503': { description: second }",
                "");
        List<Finding> findings = scan(yaml);
        assertEquals(1, findings.size(), () -> "expected exactly one finding, got " + findings);
        Finding f = findings.get(0);
        assertEquals("paths./a.post.responses.503", f.path);
        assertEquals(7, f.line, "duplicate must report the line of the SECOND occurrence");
        assertEquals(6, f.firstLine, "and we keep the first occurrence line for the operator");
    }

    /** Negative fixture: a duplicated key inside a sequence element is reached too. */
    @Test
    void detectsDuplicateInsideSequence(@TempDir Path tmp) throws IOException {
        String yaml = String.join("\n",
                "components:",
                "  schemas:",
                "    S:",
                "      properties:",
                "        a: { type: string }",
                "      properties:",
                "        b: { type: string }",
                "");
        List<Finding> findings = scan(yaml);
        assertEquals(List.of("components.schemas.S.properties"),
                findings.stream().map(f -> f.path).toList());
    }

    /** Positive fixture: a clean document yields nothing (guards against a detector that always fires). */
    @Test
    void cleanDocumentHasNoFindings() {
        String yaml = String.join("\n",
                "paths:",
                "  /a:",
                "    post:",
                "      responses:",
                "        '200': { description: ok }",
                "        '503': { description: nope }",
                "");
        assertEquals(List.of(), scan(yaml));
    }

    // ------------------------------------------------------------------ detector

    record Finding(String path, int line, int column, int firstLine) {}

    private static List<Finding> scan(String text) {
        List<Finding> out = new ArrayList<>();
        Node root;
        try (Reader reader = new java.io.StringReader(text)) {
            root = new Yaml().compose(reader);
        } catch (IOException e) {
            throw new IllegalStateException("cannot read fixture", e);
        }
        walk(root, "", out);
        return out;
    }

    private static void walk(Node node, String path, List<Finding> out) {
        if (node instanceof MappingNode mapping) {
            Map<String, Node> seen = new HashMap<>();
            for (NodeTuple tuple : mapping.getValue()) {
                Node keyNode = tuple.getKeyNode();
                String key = keyNode instanceof ScalarNode scalar ? scalar.getValue() : "<complex>";
                String childPath = path.isEmpty() ? key : path + "." + key;
                Node previous = seen.putIfAbsent(key, keyNode);
                if (previous != null) {
                    Mark mark = keyNode.getStartMark();
                    out.add(new Finding(childPath, mark.getLine() + 1, mark.getColumn() + 1,
                            previous.getStartMark().getLine() + 1));
                }
                walk(tuple.getValueNode(), childPath, out);
            }
        } else if (node instanceof SequenceNode sequence) {
            int index = 0;
            for (Node child : sequence.getValue()) {
                walk(child, path + "[" + (index++) + "]", out);
            }
        }
    }
}
