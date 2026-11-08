package com.cc01cc.p.xihe.cp.plugin;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * PLAN-0691 T2.2: the only place that turns a manifest declaration into a PostgreSQL identifier.
 *
 * <p>Two properties are load bearing and both are asserted by
 * {@code PluginRecordsIndexNamingTest} / {@code PluginRecordsIndexExecutorTest}:</p>
 *
 * <ul>
 *   <li><b>Determinism</b> — the same declaration always maps to the same name, so a retried install
 *       does not accumulate parallel indexes.</li>
 *   <li><b>Recomputability</b> — the inputs are exactly {@code (binding_id, collection, index_name)},
 *       which are the three key columns of {@code plugin_index_declarations} (spec/data-plane.md
 *       DP-3). Uninstall cleanup therefore recomputes the physical name from the ledger row alone and
 *       can issue {@code DROP INDEX IF EXISTS}, i.e. cleanup stays idempotent after a crash without
 *       storing a fourth, derived column.</li>
 * </ul>
 *
 * <p>{@code version}/{@code digest} are deliberately <b>not</b> hash inputs: DP-3 keeps one ledger row
 * per {@code (binding_id, collection, index_name)}, so an upgrade rewrites that row's {@code fields}
 * instead of creating a second identity. A digest or version in the name would leave the previous
 * index undeletable (no ledger row names it any more) and {@code CREATE INDEX IF NOT EXISTS} would
 * then silently keep the stale definition — the executor handles upgrades by rebuilding under this
 * stable name instead.</p>
 *
 * <p>Every segment is validated before use. Identifiers cannot be bound as statement parameters, so
 * a value that does not match the manifest's own grammar is rejected rather than escaped
 * (fail-closed, QUOTA-8 → 422).</p>
 */
public final class PluginIndexNaming {

    /** PostgreSQL {@code NAMEDATALEN - 1}; longer identifiers are silently truncated by the server. */
    static final int MAX_IDENTIFIER = 63;

    /** {@code pi_} = plugin index; the namespace prefix that keeps these apart from other tables. */
    static final String PREFIX = "pi_";

    private static final int HASH_HEX = 12;
    private static final String SEPARATOR = "_";
    private static final Pattern SEGMENT = Pattern.compile("^[a-z][a-z0-9_]{0,31}$");

    private PluginIndexNaming() {
    }

    /** Whether {@code value} is a manifest-legal collection/index name (schema: max 32 chars). */
    public static boolean isSafeSegment(String value) {
        return value != null && SEGMENT.matcher(value).matches();
    }

    /**
     * Whether a declaration may reach {@code CREATE INDEX}: name, collection and every field must be
     * manifest-legal — the field name and its frozen type (an undefined type has no expression to
     * build) — and at least one field must be declared.
     */
    public static boolean isDeclarable(PluginIndexDeclaration declaration) {
        if (declaration == null || !isSafeSegment(declaration.collection())
                || !isSafeSegment(declaration.name())) {
            return false;
        }
        List<PluginIndexDeclaration.DeclaredField> fields = declaration.fields();
        if (fields.isEmpty() || fields.size() > 4) {
            return false;
        }
        for (PluginIndexDeclaration.DeclaredField field : fields) {
            if (!isSafeSegment(field.name())) {
                return false;
            }
        }
        return true;
    }

    /**
     * The physical index name for one ledger identity.
     *
     * <p>Shape: {@code pi_<collection>_<index>_<12 hex>}, truncated (deterministically, longest part
     * first) to fit {@link #MAX_IDENTIFIER}. The hash covers the full untruncated identity, so
     * truncation cannot collide two different declarations.</p>
     *
     * @throws IllegalArgumentException when a segment is not manifest-legal — callers validate with
     *     {@link #isDeclarable} and turn that into a 422 first; this guard only proves that no
     *     unvalidated value can ever be spliced into DDL
     */
    public static String physicalName(UUID bindingId, String collection, String indexName) {
        if (bindingId == null) {
            throw new IllegalArgumentException("bindingId is required");
        }
        if (!isSafeSegment(collection) || !isSafeSegment(indexName)) {
            throw new IllegalArgumentException("illegal plugin index segment: " + collection + "/"
                    + indexName);
        }
        String digest = sha256Hex(bindingId + "|" + collection + "|" + indexName);
        String suffix = SEPARATOR + digest.substring(0, HASH_HEX);
        int budget = MAX_IDENTIFIER - PREFIX.length() - suffix.length();
        String semantic = collection + SEPARATOR + indexName;
        if (semantic.length() > budget) {
            int collectionBudget = Math.min(collection.length(), Math.max(budget / 2, 1));
            String head = collection.substring(0, collectionBudget);
            int indexBudget = budget - head.length() - SEPARATOR.length();
            String tail = indexName.length() > indexBudget
                    ? indexName.substring(0, Math.max(indexBudget, 1))
                    : indexName;
            semantic = head + SEPARATOR + tail;
            if (semantic.length() > budget) {
                semantic = semantic.substring(0, budget);
            }
        }
        return PREFIX + semantic + suffix;
    }

    private static String sha256Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(
                    digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            // Every JRE is required to ship SHA-256; if it is missing the platform is broken and an
            // index name cannot be derived safely, so fail loudly instead of falling back to a
            // predictable name.
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }
}
