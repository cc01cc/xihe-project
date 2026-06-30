package com.cc01cc.p.xihe.cp.mcp;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ToolNameRewriterTest {

    private final ToolNameRewriter rewriter = new ToolNameRewriter();

    @Test
    void addPrefix_combinesBackendAndTool() {
        assertEquals("runtime__read_file", rewriter.addPrefix("runtime", "read_file"));
    }

    @Test
    void addPrefix_handlesEmptyBackend() {
        assertEquals("__read_file", rewriter.addPrefix("", "read_file"));
    }

    @Test
    void removePrefix_returnsBackendAndName() {
        String[] parts = rewriter.removePrefix("runtime__read_file");
        assertArrayEquals(new String[]{"runtime", "read_file"}, parts);
    }

    @Test
    void removePrefix_noPrefixReturnsEmptyBackend() {
        String[] parts = rewriter.removePrefix("read_file");
        assertArrayEquals(new String[]{"", "read_file"}, parts);
    }

    @Test
    void removePrefix_handlesMultipleSeparators() {
        String[] parts = rewriter.removePrefix("a__b__c");
        assertArrayEquals(new String[]{"a", "b__c"}, parts);
    }

    @Test
    void addPrefixThenRemovePrefix_roundtrips() {
        String original = "read_file";
        String prefixed = rewriter.addPrefix("runtime", original);
        String[] parts = rewriter.removePrefix(prefixed);
        assertEquals("runtime", parts[0]);
        assertEquals(original, parts[1]);
    }
}
