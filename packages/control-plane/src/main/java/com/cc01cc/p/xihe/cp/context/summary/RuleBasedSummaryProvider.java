package com.cc01cc.p.xihe.cp.context.summary;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * PLAN-0354 T1.1: rule-based implementation of the SummaryProvider seam.
 *
 * <p>The body is the PLAN-294 decision #3 / PLAN-0341 T1.3 structured sectioned
 * summary moved verbatim out of ContextService (V1: behaviour identical to the
 * 0341 baseline, including the [Constraints] position before [Files&Artifacts]).
 */
@Service
public class RuleBasedSummaryProvider implements SummaryProvider {

    private static final int GOAL_MAX_CHARS = 500;
    private static final int ERRORS_KEPT = 3;
    private static final int NEXT_MOVE_MAX_CHARS = 300;

    // PLAN-294 decision #7 (M2): messages inside the recent window are kept
    // verbatim in the projection and excluded from summarization (PLAN-0354:
    // mirrors ContextService.KEEP_RECENT_MESSAGES).
    static final int KEEP_RECENT_MESSAGES = 10;

    private static final Pattern FILE_PATH_PATTERN = Pattern.compile(
            "[A-Za-z0-9_\\-./]+\\.[A-Za-z0-9]{1,8}");

    private final ConstraintExtractor constraintExtractor;

    public RuleBasedSummaryProvider(ConstraintExtractor constraintExtractor) {
        this.constraintExtractor = constraintExtractor;
    }

    @Override
    public SummaryResult summarize(SummaryRequest request) {
        long started = System.currentTimeMillis();
        String summary = summarize(request.sessionId(), request.context(), request.previousSummary());
        return new SummaryResult(
                summary,
                "rule",
                "",
                System.currentTimeMillis() - started,
                "estimated",
                null,
                null);
    }

    String summarize(String sessionId, ObjectNode context, String previousSummary) {
        ArrayNode messages = (ArrayNode) context.get("messages");
        if (messages == null || messages.isEmpty()) {
            return previousSummary != null ? previousSummary : "No messages to compact.";
        }

        // Parse prior summary into sections (carry-forward source).
        Map<String, String> prior = SummarySections.parse(previousSummary);

        StringBuilder goal = new StringBuilder();
        Set<String> files = new LinkedHashSet<>();
        List<String> errors = new ArrayList<>();
        List<String> recent = new ArrayList<>();
        List<String> active = new ArrayList<>();
        List<String> completed = new ArrayList<>();
        StringBuilder nextMove = new StringBuilder();

        int size = messages.size();
        int recentStart = Math.max(0, size - KEEP_RECENT_MESSAGES);
        for (int i = 0; i < size; i++) {
            JsonNode msg = messages.get(i);
            String role = msg.path("role").asText("");
            String content = msg.path("content").asText("");
            if (content.isBlank()) {
                continue;
            }

            if ("human".equals(role) && goal.length() == 0) {
                goal.append(content, 0, Math.min(content.length(), GOAL_MAX_CHARS));
            }
            // File-path extraction (verbatim): workspace-relative POSIX paths.
            Matcher m = FILE_PATH_PATTERN.matcher(content);
            while (m.find()) {
                files.add(m.group());
            }
            if (content.contains("error") || content.contains("Error") || content.contains("ERROR")) {
                errors.add(content.length() > 300 ? content.substring(0, 300) : content);
            }
            if (i >= recentStart) {
                recent.add("[" + role + "] " + (content.length() > 200 ? content.substring(0, 200) : content));
            }
            // Lightweight work-state signals from task_plan metadata below.
        }

        // Task-plan driven Work State (Completed archived out of Active).
        JsonNode taskPlan = context.path("metadata").path("task_plan");
        if (taskPlan.has("items")) {
            for (JsonNode item : taskPlan.get("items")) {
                String title = item.path("title").asText(item.path("id").asText(""));
                String status = item.path("status").asText("pending");
                if (title.isBlank()) {
                    continue;
                }
                if ("completed".equals(status)) {
                    completed.add(title);
                } else {
                    active.add(title + " (" + status + ")");
                }
            }
        }
        if (nextMove.length() == 0 && !active.isEmpty()) {
            nextMove.append(active.get(0), 0, Math.min(active.get(0).length(), NEXT_MOVE_MAX_CHARS));
        } else if (nextMove.length() == 0) {
            String priorNext = prior.get(SummarySections.NEXT);
            if (priorNext != null && !priorNext.isBlank()) {
                nextMove.append(priorNext, 0, Math.min(priorNext.length(), NEXT_MOVE_MAX_CHARS));
            }
        }

        // Carry-forward: union prior files/errors with dedup.
        String priorFiles = prior.get(SummarySections.FILES);
        if (priorFiles != null && !priorFiles.isBlank()) {
            for (String f : priorFiles.split(",")) {
                String trimmed = f.trim();
                if (!trimmed.isEmpty()) {
                    files.add(trimmed);
                }
            }
        }
        String priorErrors = prior.get(SummarySections.ERRORS);
        if (priorErrors != null && !priorErrors.isBlank()) {
            for (String err : priorErrors.split("\\|")) {
                String trimmed = err.trim();
                if (!trimmed.isEmpty() && !errors.contains(trimmed)) {
                    errors.add(0, trimmed);
                }
            }
        }
        String priorActive = prior.get(SummarySections.WORK);
        if (priorActive != null && !active.isEmpty()) {
            // Prior Active items that are not in the current plan stay carried.
            for (String line : priorActive.split(";")) {
                String trimmed = line.trim();
                if (trimmed.isEmpty() || trimmed.startsWith("Completed:")) {
                    continue;
                }
                boolean already = active.stream().anyMatch(a -> trimmed.contains(a) || a.contains(trimmed));
                if (!already && !trimmed.startsWith("(")) {
                    active.add(trimmed);
                }
            }
        }

        StringBuilder sb = new StringBuilder();
        // Goal: keep prior if present (first human is often just "hi"), else extract.
        String priorGoal = prior.get(SummarySections.GOAL);
        if (priorGoal != null && !priorGoal.isBlank() && !"(not stated)".equals(priorGoal)) {
            sb.append(SummarySections.GOAL).append(' ').append(priorGoal).append('\n');
        } else {
            sb.append(SummarySections.GOAL).append(' ').append(goal.length() > 0 ? goal : "(not stated)").append('\n');
        }
        if (!active.isEmpty() || !completed.isEmpty()) {
            sb.append(SummarySections.WORK).append(' ');
            if (!active.isEmpty()) {
                sb.append("Active: ").append(String.join("; ", active));
            }
            if (!completed.isEmpty()) {
                if (!active.isEmpty()) {
                    sb.append(" | ");
                }
                sb.append("Completed: ").append(String.join("; ", completed));
            }
            sb.append('\n');
        } else if (prior.containsKey(SummarySections.WORK) && !prior.get(SummarySections.WORK).isBlank()) {
            sb.append(SummarySections.WORK).append(' ').append(prior.get(SummarySections.WORK)).append('\n');
        }
        if (nextMove.length() > 0) {
            sb.append(SummarySections.NEXT).append(' ').append(nextMove).append('\n');
        }
        // PLAN-0341 T1.5 (I6): code-extracted constraints — verbatim, never
        // summarized away. Prior Constraints are carried forward; new ones from
        // this window and decided approvals are merged with dedup.
        List<String> constraints = constraintExtractor.extract(
                sessionId, messages, prior.get(SummarySections.CONSTRAINTS));
        if (!constraints.isEmpty()) {
            sb.append(SummarySections.CONSTRAINTS).append(' ').append(String.join(" | ", constraints)).append('\n');
        }
        if (!files.isEmpty()) {
            sb.append(SummarySections.FILES).append(' ').append(String.join(", ", files)).append('\n');
        }
        if (!errors.isEmpty()) {
            sb.append(SummarySections.ERRORS).append(' ');
            int from = Math.max(0, errors.size() - ERRORS_KEPT);
            for (int i = from; i < errors.size(); i++) {
                sb.append(errors.get(i)).append(i < errors.size() - 1 ? " | " : "");
            }
            sb.append('\n');
        }
        sb.append(SummarySections.RECENT).append(' ');
        for (int i = 0; i < recent.size(); i++) {
            sb.append(recent.get(i)).append(i < recent.size() - 1 ? " ; " : "");
        }
        return sb.toString();
    }
}
