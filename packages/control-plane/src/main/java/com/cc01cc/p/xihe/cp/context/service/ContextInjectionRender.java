package com.cc01cc.p.xihe.cp.context.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * PLAN-0340: deterministic rendering helpers for L1 blocks (unit-testable).
 */
public final class ContextInjectionRender {

    private ContextInjectionRender() {
    }

    /** Root→cwd concatenation with per-file headers. M1 often has a single root path. */
    public static String renderAgentsChain(List<SourceEntry> entries) {
        if (entries == null || entries.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        sb.append("<system-reminder>\n");
        sb.append("Workspace rules from AGENTS.md chain (trusted; more specific later):\n");
        for (SourceEntry entry : entries) {
            sb.append("----- ").append(entry.path()).append(" -----\n");
            sb.append(entry.content().stripTrailing());
            sb.append('\n');
        }
        sb.append("</system-reminder>");
        return sb.toString();
    }

    /** Stable order: by path with forward slashes (decision #11 path rules). */
    public static List<SourceEntry> sortStable(List<SourceEntry> entries) {
        Map<String, SourceEntry> byPath = new LinkedHashMap<>();
        if (entries != null) {
            for (SourceEntry e : entries) {
                if (e != null && e.path() != null && !e.path().isBlank()) {
                    byPath.put(e.path().replace('\\', '/'), e);
                }
            }
        }
        List<String> paths = new ArrayList<>(byPath.keySet());
        paths.sort(String::compareTo);
        List<SourceEntry> out = new ArrayList<>();
        for (String p : paths) {
            out.add(byPath.get(p));
        }
        return out;
    }

    public record SourceEntry(String path, String content) {
    }
}
