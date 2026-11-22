package com.cc01cc.p.xihe.cp.mcp;

/**
 * task-71: the single host for the bounded-prefix preview rule CP applies before persisting
 * human-readable preview / audit text.
 *
 * <p>Before this class the rule existed as six inline literals, {@code x.length() <= 4096 ? x :
 * x.substring(0, 4096)}, spread across {@code cp/chat} and {@code cp/mcp}. The original constant
 * ({@code ToolCallSnapshotService.ARG_LIMIT}) was package-private, so the other sites could not
 * reference it and were copied instead; changing one of them silently left the rest at the old
 * bound.</p>
 *
 * <p><b>Two constants on purpose.</b> The value coincides today; the carrier and its reader do
 * not:</p>
 *
 * <ul>
 *   <li>{@link #ARGUMENTS_PREVIEW_CHARS} bounds {@code mcp_invocations.arguments_preview}
 *       ({@code V50__mcp_execution_domain.sql}). That column is parsed back by
 *       {@code ChatSubmissionService.deriveSpawnContent}, which refuses a preview at the bound
 *       because it can no longer prove the text is complete — so the write bound and the read gate
 *       are one contract and must move together.</li>
 *   <li>{@link #APPROVAL_HISTORY_PREVIEW_CHARS} bounds {@code approval_history.payload}
 *       ({@code V51__approval_history.sql}). That column is a display/audit carrier (ids, flags and
 *       tool name only) and no reader compares its length.</li>
 * </ul>
 *
 * <p>Merging them would let a future change to one carrier silently rewrite what the other
 * persists. Splitting them further by input shape (arguments object vs raw HTTP body) would be
 * wrong for the opposite reason: shape is not semantics, and every one of those sites writes the
 * same column under the same rule.</p>
 *
 * <p>The unit is {@link String#length()} (UTF-16 code units), not bytes; the older prose calling
 * this a "4096-byte" rule is approximate.</p>
 *
 * <p>Why {@code cp/mcp} and not {@code cp/util}: {@code util} is the dependency-free technical
 * facility package and would be the neutral home, but it is outside task-71's write scope. The MCP
 * slice owns the preview-column contract (the table and 5 of the 6 call sites), and {@code cp/chat}
 * already depends on {@code cp/mcp}, so the class sits next to its owner.</p>
 */
public final class PreviewLimits {

    /** Bound for {@code mcp_invocations.arguments_preview}: writer and read-side gate. */
    public static final int ARGUMENTS_PREVIEW_CHARS = 4096;

    /** Bound for {@code approval_history.payload}: audit/display carrier, never parsed back. */
    public static final int APPROVAL_HISTORY_PREVIEW_CHARS = 4096;

    private PreviewLimits() {
    }
}
