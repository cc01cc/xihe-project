package com.cc01cc.p.xihe.cp.policy;

import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Tool face registry: maps a tool name to its {@code actionClass} and {@link ToolShape}
 * (PLAN-0328 decision #30/#38, spec §8).
 *
 * <p>Action classes are <em>extensible strings</em> — the built-in set below is a starting point,
 * not a closed enum. Tools that are known but not classified resolve to
 * {@link PolicyLayer#UNCLASSIFIED_ACTION} with {@link ToolShape#OPAQUE} (default ask + no reuse).</p>
 */
public class ToolFaceRegistry {

    public record Face(String actionClass, ToolShape shape) {}

    public static final String ACTION_READ = "read";
    public static final String ACTION_WRITE = "write";
    public static final String ACTION_DELETE = "delete";
    public static final String ACTION_EXEC = "exec";
    public static final String ACTION_NETWORK = "network";
    public static final String ACTION_CREDENTIAL = "credential";

    private static final Set<String> READ_TOOLS = Set.of(
            "read_file", "read_file_range", "list_directory", "glob", "grep",
            "get_file_info", "watch_directory", "extract_pdf_text",
            "read_command_output", "list_background_processes", "get_background_process");

    private static final Set<String> WRITE_TOOLS = Set.of(
            "write_file", "edit_file", "delete_file", "delete_directory",
            "move_file", "copy_file", "mkdir", "apply_patch");

    private static final Set<String> EXEC_TOOLS = Set.of(
            "execute_command", "start_background_process", "cancel_background_process");

    private static final Set<String> NETWORK_TOOLS = Set.of("web_fetch");

    private final Map<String, Face> faces;

    public ToolFaceRegistry() {
        this(Map.of());
    }

    /** Extra faces (e.g. classified third-party MCP tools) layered on top of the built-ins. */
    public ToolFaceRegistry(Map<String, Face> extraFaces) {
        var builder = new java.util.HashMap<String, Face>();
        READ_TOOLS.forEach(tool -> builder.put(tool, new Face(ACTION_READ, ToolShape.STRUCTURED)));
        WRITE_TOOLS.forEach(tool -> builder.put(tool, new Face(ACTION_WRITE, ToolShape.STRUCTURED)));
        NETWORK_TOOLS.forEach(tool -> builder.put(tool, new Face(ACTION_NETWORK, ToolShape.STRUCTURED)));
        EXEC_TOOLS.forEach(tool -> builder.put(tool, new Face(ACTION_EXEC, ToolShape.INTERPRETER)));
        builder.putAll(extraFaces);
        this.faces = Map.copyOf(builder);
    }

    /** True when the tool is present in the registry (built-in or explicitly classified). */
    public boolean known(String tool) {
        return tool != null && faces.containsKey(tool);
    }

    public Face faceOf(String tool) {
        Face face = tool == null ? null : faces.get(tool);
        return face != null ? face : new Face(PolicyLayer.UNCLASSIFIED_ACTION, ToolShape.OPAQUE);
    }

    public Optional<Face> configuredFace(String tool) {
        return Optional.ofNullable(tool == null ? null : faces.get(tool));
    }

    public Set<String> knownTools() {
        return faces.keySet();
    }

    /** Built-in action classes; callers may add their own (e.g. {@code db-migration}). */
    public static Set<String> builtinActionClasses() {
        return Set.of(ACTION_READ, ACTION_WRITE, ACTION_DELETE, ACTION_EXEC, ACTION_NETWORK, ACTION_CREDENTIAL);
    }
}
