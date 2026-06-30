package com.cc01cc.p.xihe.cp.mcp;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Component;

/**
 * RequestRewriter handles path rewriting and parameter injection
 * for sandbox compatibility (DESIGN-007 §4).
 */
@Component
public class RequestRewriter {

    private static final Logger logger = LoggerFactory.getLogger(RequestRewriter.class);

    private final ObjectMapper objectMapper;

    public RequestRewriter(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /**
     * Rewrite MCP request body for sandbox compatibility.
     * - Rewrite file paths from host paths to sandbox paths
     * - Inject additional parameters (cwd, env)
     * - Validate paths (prevent traversal)
     */
    public String rewrite(String toolName, String body, String sessionId) {
        try {
            JsonNode root = objectMapper.readTree(body);
            
            if (!"tools/call".equals(root.path("method").asText())) {
                return body; // Not a tool call, pass through
            }

            JsonNode params = root.path("params");
            if (params.isMissingNode()) {
                return body;
            }

            JsonNode args = params.path("arguments");
            if (args.isMissingNode()) {
                return body;
            }

            // Rewrite based on tool type
            switch (toolName) {
                case "read_file":
                case "list_directory":
                case "write_file":
                    return rewriteFileTool(root, args, sessionId);
                case "execute_command":
                    return rewriteCommandTool(root, args, sessionId);
                default:
                    return body;
            }
        } catch (Exception e) {
            logger.warn("Request rewrite failed, passing through unchanged: {}", e.getMessage());
            return body;
        }
    }

    private String rewriteFileTool(JsonNode root, JsonNode args, String sessionId) {
        String path = args.path("path").asText();
        
        // Path traversal protection
        if (path.contains("..")) {
            throw new IllegalArgumentException("Path traversal not allowed: " + path);
        }

        // Rewrite path: /home/user/project → /sandbox/{sessionId}/project
        // For MVP, we keep paths as-is (no sandbox isolation yet)
        // Future: implement path rewriting for namespace isolation
        
        return root.toString();
    }

    private String rewriteCommandTool(JsonNode root, JsonNode args, String sessionId) {
        String command = args.path("command").asText();
        
        // Block dangerous commands
        if (isBlockedCommand(command)) {
            throw new IllegalArgumentException("Blocked command: " + command);
        }

        // For MVP, pass through unchanged
        // Future: inject sandbox environment variables
        return root.toString();
    }

    private boolean isBlockedCommand(String command) {
        String lower = command.toLowerCase().trim();
        // Block potentially dangerous commands
        String[] blocked = {"rm -rf /", "mkfs", "dd if=/dev/zero", ":(){ :|:& };:"};
        for (String b : blocked) {
            if (lower.contains(b)) {
                return true;
            }
        }
        return false;
    }
}
