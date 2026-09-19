package com.cc01cc.p.xihe.cp.context.summary;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * PLAN-0354 spec §4: shared summary section vocabulary and parser.
 *
 * <p>The sectioned summary format originates from PLAN-294 decision #3 /
 * PLAN-0341 T1.3. Both providers (rule/llm) and ContextService (truncation
 * degradation) render the same headers, so the constants live here instead of
 * inside a provider.
 */
public final class SummarySections {

    public static final String GOAL = "[Goal]";
    public static final String WORK = "[Work State]";
    public static final String NEXT = "[Next Move]";
    public static final String FILES = "[Files&Artifacts]";
    public static final String ERRORS = "[Errors]";
    public static final String RECENT = "[Recent]";
    public static final String CONSTRAINTS = "[Constraints]";

    private SummarySections() {
    }

    /** Parse a sectioned summary into a map of section header → body. */
    public static Map<String, String> parse(String summary) {
        Map<String, String> sections = new LinkedHashMap<>();
        if (summary == null || summary.isBlank()) {
            return sections;
        }
        String[] lines = summary.split("\n");
        String current = null;
        StringBuilder body = new StringBuilder();
        for (String line : lines) {
            if (line.startsWith("[") && line.contains("]")) {
                if (current != null) {
                    sections.put(current, body.toString().trim());
                }
                int end = line.indexOf(']');
                current = line.substring(0, end + 1);
                body = new StringBuilder();
                String rest = line.substring(end + 1).trim();
                if (!rest.isEmpty()) {
                    body.append(rest);
                }
            } else if (current != null) {
                if (body.length() > 0) {
                    body.append(' ');
                }
                body.append(line.trim());
            }
        }
        if (current != null) {
            sections.put(current, body.toString().trim());
        }
        return sections;
    }

    /**
     * PLAN-0354 spec §4 (I3): drop one section (header + body) from a summary.
     * Used to strip {@code [Constraints]} before the text reaches the LLM.
     */
    public static String withoutSection(String summary, String section) {
        if (summary == null || summary.isBlank()) {
            return summary;
        }
        StringBuilder out = new StringBuilder();
        boolean skipping = false;
        for (String line : summary.split("\n", -1)) {
            if (line.startsWith("[") && line.contains("]")) {
                int end = line.indexOf(']');
                String header = line.substring(0, end + 1);
                skipping = header.equals(section);
                if (skipping) {
                    continue;
                }
            }
            if (!skipping) {
                if (out.length() > 0) {
                    out.append('\n');
                }
                out.append(line);
            }
        }
        return out.toString().trim();
    }
}
