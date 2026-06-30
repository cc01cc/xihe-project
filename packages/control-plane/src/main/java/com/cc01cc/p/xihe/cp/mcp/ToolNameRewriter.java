package com.cc01cc.p.xihe.cp.mcp;

import org.springframework.stereotype.Component;

/**
 * ToolNameRewriter handles namespace isolation for MCP tools (DESIGN-009).
 * Adds/removes prefixes to prevent tool name conflicts across MCP servers.
 */
@Component
public class ToolNameRewriter {

    /**
     * Add namespace prefix to tool name.
     * e.g., "read_file" → "runtime__read_file"
     */
    public String addPrefix(String backend, String toolName) {
        return backend + "__" + toolName;
    }

    /**
     * Remove namespace prefix and return [backend, originalName].
     * e.g., "runtime__read_file" → ["runtime", "read_file"]
     */
    public String[] removePrefix(String prefixedName) {
        int sep = prefixedName.indexOf("__");
        if (sep == -1) {
            return new String[]{"", prefixedName};
        }
        return new String[]{
            prefixedName.substring(0, sep),
            prefixedName.substring(sep + 2)
        };
    }
}
