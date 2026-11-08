package com.cc01cc.p.xihe.cp.plugin.records;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * PLAN-0691 T2.3: plugin records quota / limit values (spec/data-plane.md §2 QUOTA-6, QUOTA-7,
 * QUOTA-13 and the §2.1 property names).
 *
 * <p>Same contract as {@code PluginKvLimits}: every number is copied from spec §2, the {@code HARD_*}
 * constant is the spec's ceiling, and exceeding it is a startup failure rather than a runtime 429
 * (spec §2.1: {@code env <= 上限}, fail-fast).
 *
 * <p>The env variable is spelled out as the placeholder default because Spring's
 * {@code SystemEnvironmentPropertySource} maps {@code .} to {@code _} but not {@code -} to
 * {@code _}: {@code cp.plugin.records.max-docs} alone would never resolve
 * {@code XIHE_CP_PLUGIN_RECORDS_MAX_DOCS} (spec §2.1 prescribes exactly this placeholder form).
 *
 * <p>QUOTA-13 ({@code statement_timeout} 5s) is the one number here that is not a plugin quota: §2.1
 * says it <b>reuses the existing</b> {@code cp.lock-timeout-ms} (default 5000) instead of minting a
 * new env name. The records surface is the first plugin surface that runs caller-shaped SQL against
 * {@code plugin_records}, so it is the first one that has a use for the value — the KV surface
 * declared it as "no consumer" in T1.5 and that note stays true for KV.
 */
@Component
public class PluginRecordsLimits {

    /** QUOTA-6 hard cap: {@code records.maxDocs} 50000 (default) / 200000 (hard). */
    static final int HARD_MAX_DOCS = 200_000;
    /** QUOTA-7 hard cap: {@code records.docBytesMax} 262144 (default) / 1048576 (hard). */
    static final int HARD_DOC_BYTES_MAX = 1_048_576;
    /**
     * QUOTA-13 upper bound for {@code statement_timeout}. The spec fixes the value at 5s and gives no
     * hard cap; a ceiling is needed anyway because an unbounded timeout would silently disable the
     * 429 path it exists for. 60000 ms mirrors the largest {@code limits.timeoutMs} a manifest may
     * declare (QUOTA-11), so the two "how long may a plugin run" numbers cannot contradict.
     */
    static final int HARD_STATEMENT_TIMEOUT_MS = 60_000;

    /**
     * API-12 ceiling for one page (spec §5: {@code limit ≤ 200}). Same number as the KV listing
     * ceiling because both are the same clause family; a different value would need a spec change,
     * not a local constant.
     */
    static final int MAX_PAGE_LIMIT = 200;

    /** API-12 gives a ceiling but no default; using the ceiling avoids inventing a second number. */
    static final int DEFAULT_PAGE_LIMIT = MAX_PAGE_LIMIT;

    /**
     * API-12 {@code in(...)} arity ceiling. The spec bounds pages and documents, not the size of one
     * filter, so this is an implementation guard: an {@code in} list is expanded to one JDBC
     * placeholder per element, and an unbounded list would both blow the prepared-statement parameter
     * budget and defeat "no unbounded scan" (spec §5 pagination row).
     */
    static final int MAX_IN_VALUES = 200;

    private final int maxDocs;
    private final int docBytesMax;
    private final int statementTimeoutMs;

    public PluginRecordsLimits(
            @Value("${cp.plugin.records.max-docs:${XIHE_CP_PLUGIN_RECORDS_MAX_DOCS:50000}}") int maxDocs,
            @Value("${cp.plugin.records.doc-bytes-max:${XIHE_CP_PLUGIN_RECORDS_DOC_BYTES_MAX:262144}}")
            int docBytesMax,
            @Value("${cp.lock-timeout-ms:${XIHE_CP_LOCK_TIMEOUT_MS:5000}}") int statementTimeoutMs) {
        this.maxDocs = requireWithin("cp.plugin.records.max-docs", maxDocs, HARD_MAX_DOCS);
        this.docBytesMax = requireWithin("cp.plugin.records.doc-bytes-max", docBytesMax,
                HARD_DOC_BYTES_MAX);
        this.statementTimeoutMs = requireWithin("cp.lock-timeout-ms", statementTimeoutMs,
                HARD_STATEMENT_TIMEOUT_MS);
    }

    /** spec §2.1: {@code env <= 上限} is checked at startup and fails fast when violated. */
    private static int requireWithin(String name, int value, int hardCap) {
        if (value < 1 || value > hardCap) {
            throw new IllegalStateException(
                    "PLAN-0691: " + name + "=" + value + " is outside 1.." + hardCap
                            + " (spec/data-plane.md §2 hard cap); fix the deployment env, "
                            + "the hard cap is frozen until M2 review");
        }
        return value;
    }

    /** QUOTA-6: max documents per collection (counted per binding + collection). */
    public int maxDocs() {
        return maxDocs;
    }

    /** QUOTA-7: CP-side ceiling for one serialised document, before a manifest narrows it. */
    public int docBytesMax() {
        return docBytesMax;
    }

    /** QUOTA-13: {@code statement_timeout} applied to every records statement, in milliseconds. */
    public int statementTimeoutMs() {
        return statementTimeoutMs;
    }

    /**
     * A copy with a different statement timeout.
     *
     * <p>Exists so the timeout test can drive a real 57014 without patching a context-wide property
     * (and without waiting the production 5 s); production always uses the {@code @Value} path.
     */
    public PluginRecordsLimits withStatementTimeoutMs(int millis) {
        return new PluginRecordsLimits(maxDocs, docBytesMax, millis);
    }
}
