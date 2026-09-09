package com.cc01cc.p.xihe.cp.mcp;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import static org.junit.jupiter.api.Assertions.*;

class RequestRewriterTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final RequestRewriter rewriter = new RequestRewriter(mapper);

    @Test
    void stripsLeadingSlashOnWriteFile() {
        String body = """
            {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_file","arguments":{"path":"/a.md","content":"x"}}}
            """;
        String out = rewriter.rewrite("write_file", body, "s1");
        assertTrue(out.contains("\"path\":\"a.md\""), out);
        assertFalse(out.contains("\"/a.md\""), out);
    }

    @Test
    void keepsRelativePath() {
        String body = """
            {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_file","arguments":{"path":"b/c.md","content":"x"}}}
            """;
        String out = rewriter.rewrite("write_file", body, "s1");
        assertTrue(out.contains("\"path\":\"b/c.md\""), out);
    }

    @Test
    void doesNotNormalizeDotDotPaths() {
        String body = """
            {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_file","arguments":{"path":"../x.md","content":"x"}}}
            """;
        // rewrite() catches traversal and passes body through; Runtime still rejects.
        String out = rewriter.rewrite("write_file", body, "s1");
        assertTrue(out.contains("\"../x.md\""), out);
    }
}
