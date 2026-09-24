package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/** PLAN-0328 M1: MCP argument → resource extraction (spec §8.1 binding scope). */
class PolicyResourceExtractorTest {

    @Test
    void extractsPathKey() {
        String body = "{\"method\":\"tools/call\",\"params\":{\"name\":\"read_file\","
                + "\"arguments\":{\"path\":\"src/a.ts\",\"offset\":0}}}";

        assertEquals(List.of("src/a.ts"), PolicyResourceExtractor.extract(body));
    }

    @Test
    void extractsCommandKey() {
        String body = "{\"params\":{\"arguments\":{\"command\":\"git status\",\"timeout\":30}}}";

        assertEquals(List.of("git status"), PolicyResourceExtractor.extract(body));
    }

    @Test
    void flattensKnownArrayKeys() {
        String body = "{\"params\":{\"arguments\":{\"paths\":[\"src/a.ts\",\"src/b.ts\"],"
                + "\"files\":[\"docs/readme.md\"]}}}";

        assertEquals(List.of("src/a.ts", "src/b.ts", "docs/readme.md"),
                PolicyResourceExtractor.extract(body));
    }

    @Test
    void extractsPatchPathsFromStructuredPatches() {
        String body = "{\"params\":{\"arguments\":{\"patches\":["
                + "{\"path\":\"src/a.ts\",\"hunks\":[]},"
                + "{\"path\":\"docs/readme.md\",\"hunks\":[]}]}}}";

        assertEquals(List.of("src/a.ts", "docs/readme.md"), PolicyResourceExtractor.extract(body));
    }

    @Test
    void trimsDropsBlanksAndDeduplicatesPreservingOrder() {
        String body = "{\"params\":{\"arguments\":{\"path\":\"  src/a.ts  \","
                + "\"target\":\"src/a.ts\",\"destination\":\"   \",\"paths\":[\"\",\"src/b.ts\"]}}}";

        assertEquals(List.of("src/a.ts", "src/b.ts"), PolicyResourceExtractor.extract(body));
    }

    @Test
    void unknownKeysAndNestedObjectsFallBackToWildcard() {
        String body = "{\"params\":{\"arguments\":{\"count\":3,\"nested\":{\"path\":\"src/a.ts\"},"
                + "\"flags\":[\"x\"]}}}";

        assertEquals(List.of("*"), PolicyResourceExtractor.extract(body));
    }

    @Test
    void malformedOrMissingBodyFallsBackToWildcard() {
        assertEquals(List.of("*"), PolicyResourceExtractor.extract("not json"));
        assertEquals(List.of("*"), PolicyResourceExtractor.extract(""));
        assertEquals(List.of("*"), PolicyResourceExtractor.extract(null));
    }

    @Test
    void resourceCountOverflowProducesFailClosedMarker() {
        StringBuilder paths = new StringBuilder();
        for (int i = 0; i < 25; i++) {
            if (i > 0) {
                paths.append(',');
            }
            paths.append("\"src/f").append(i).append(".ts\"");
        }
        String body = "{\"params\":{\"arguments\":{\"paths\":[" + paths + "]}}}";

        List<String> resources = PolicyResourceExtractor.extract(body);

        assertEquals(21, resources.size());
        assertEquals("src/f0.ts", resources.get(0));
        assertEquals("src/f19.ts", resources.get(19));
        assertTrue(PolicyResourceExtractor.hasInvalidResource(resources));
    }

    @Test
    void resourceLengthOverflowProducesFailClosedMarker() {
        String longPath = "a".repeat(3000);
        String body = "{\"params\":{\"arguments\":{\"path\":\"" + longPath + "\"}}}";

        List<String> resources = PolicyResourceExtractor.extract(body);

        assertEquals(1, resources.size());
        assertTrue(PolicyResourceExtractor.hasInvalidResource(resources));
    }
}
