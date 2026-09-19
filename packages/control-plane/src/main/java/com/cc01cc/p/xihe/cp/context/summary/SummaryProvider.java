package com.cc01cc.p.xihe.cp.context.summary;

import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Map;

/**
 * PLAN-0354 spec §1: minimal SummaryProvider seam frozen by PLAN-0341 §2.2 and
 * implemented here.
 *
 * <p>Input = pruned projection view + prior summary; output = sectioned summary
 * + token accounting. Implementations must not throw for operational failures:
 * the LLM implementation degrades to the rule implementation and records a
 * {@code fallbackReason} (invariant I1).
 */
public interface SummaryProvider {

    SummaryResult summarize(SummaryRequest request);

    /**
     * @param context         pruned projection view (projectUpTo result:
     *                        messages/metadata/epoch); read-only for providers
     * @param previousSummary prior compaction.applied summary, may be null
     * @param previousCursor  prior up_to_sequence (0 = first compaction)
     * @param trigger         auto | overflow | manual (routing is decided by the
     *                        caller; providers only echo it into logs)
     * @param runId           active chat run for pre-run/overflow gates; null for
     *                        manual compaction
     */
    record SummaryRequest(
            String sessionId,
            String workspaceId,
            String userId,
            ObjectNode context,
            String previousSummary,
            long previousCursor,
            String trigger,
            String runId) {
    }

    /**
     * @param provider       "rule" | "llm" — who actually produced the summary
     * @param model          provider/model for llm, "" for rule
     * @param durationMs     provider wall time (includes the rule fallback leg)
     * @param source         real | estimated | fallback token accounting basis
     * @param fallbackReason non-null only after a fallback (spec §5 enum)
     * @param usage          non-null only when an LLM call completed (0343-named
     *                       fields); may coexist with a rule provider when the
     *                       LLM result failed shrink validation
     */
    record SummaryResult(
            String summary,
            String provider,
            String model,
            long durationMs,
            String source,
            String fallbackReason,
            Map<String, Object> usage) {
    }
}
