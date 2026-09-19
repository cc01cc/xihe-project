package com.cc01cc.p.xihe.cp.context.summary;

import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * PLAN-0341 T1.5 (decision #31) / PLAN-0354 spec §4: rule-based SC subset.
 *
 * <p>Approval decisions and explicit user constraints are code-extracted and
 * kept verbatim; they never participate in the LLM summarizer's take-data
 * (invariant I3). Moved out of ContextService unchanged when the SummaryProvider
 * seam landed (PLAN-0354 T1.1).
 */
@Component
public class ConstraintExtractor {

    private static final Logger logger = LoggerFactory.getLogger(ConstraintExtractor.class);

    private static final int CONSTRAINTS_MAX = 12;
    private static final int CONSTRAINT_MAX_CHARS = 240;
    private static final java.util.regex.Pattern CONSTRAINT_PATTERN = java.util.regex.Pattern.compile(
            "(?:不要动|不要改|不要提交|禁止|必须先|务必先|不要删除|别动|别改|"
                    + "do not|don't|never|must always|must not|forbid|stop)\\b[^.\\n。！!？?]{0,120}",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    private final ChatApprovalRepository approvalRepository;

    public ConstraintExtractor(ChatApprovalRepository approvalRepository) {
        this.approvalRepository = approvalRepository;
    }

    /** Verbatim constraints: prior carry-forward + user spans + decided approvals. */
    public List<String> extract(String sessionId, ArrayNode messages, String priorConstraints) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        if (priorConstraints != null && !priorConstraints.isBlank()) {
            for (String part : priorConstraints.split("\\|")) {
                String trimmed = part.trim();
                if (!trimmed.isEmpty()) {
                    out.add(trimmed);
                }
            }
        }
        // ① User explicit constraints from human messages (verbatim match span).
        if (messages != null) {
            for (var msg : messages) {
                if (!"human".equals(msg.path("role").asText(""))) {
                    continue;
                }
                String content = msg.path("content").asText("");
                if (content.isBlank()) {
                    continue;
                }
                var matcher = CONSTRAINT_PATTERN.matcher(content);
                while (matcher.find() && out.size() < CONSTRAINTS_MAX) {
                    String span = matcher.group().trim();
                    if (span.length() > CONSTRAINT_MAX_CHARS) {
                        span = span.substring(0, CONSTRAINT_MAX_CHARS);
                    }
                    out.add(span);
                }
            }
        }
        // ② Decided approvals (verbatim tool/action + decision).
        try {
            var decided = approvalRepository.findBySessionIdAndStateInOrderByCreatedAtDesc(
                    sessionId, List.of("approved", "rejected", "expired"));
            for (var approval : decided) {
                if (out.size() >= CONSTRAINTS_MAX) {
                    break;
                }
                String decision = Boolean.TRUE.equals(approval.getApproved()) ? "approved"
                        : Boolean.FALSE.equals(approval.getApproved()) ? "denied"
                        : approval.getState();
                String line = "[" + decision + "] " + approval.getTool() + ": "
                        + truncate(approval.getAction(), 120);
                out.add(line);
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=constraint_approval_extract_failed sessionId={} error={}",
                    sessionId, e.getMessage());
        }
        return new ArrayList<>(out);
    }

    /** Extract and render the [Constraints] section body, or null when empty. */
    public String renderSection(String sessionId, ArrayNode messages, String priorConstraints) {
        List<String> constraints = extract(sessionId, messages, priorConstraints);
        if (constraints.isEmpty()) {
            return null;
        }
        return SummarySections.CONSTRAINTS + " " + String.join(" | ", constraints);
    }

    private static String truncate(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max);
    }
}
