package com.cc01cc.p.xihe.cp.plugin.kv;

import java.time.Instant;

/**
 * PLAN-0691 T1.5: one {@code plugin_kv} row as read from the database.
 *
 * <p>The value is kept as its JSON text instead of a Jackson node so the persistence layer never
 * decides how a document is bound: PostgreSQL {@code jsonb} normalises the document on write, and
 * {@code value::text} is the exact text a later read has to parse. The controller re-serialises the
 * parsed {@link tools.jackson.databind.JsonNode} through Jackson 3 (the wire mapper), so no
 * Jackson-2 node can leak into a response (PLAN-0633 C1).
 *
 * @param key       KV key (unique inside a binding's namespace)
 * @param valueJson the document text as stored ({@code jsonb} canonical form)
 * @param version   CAS version, owned by CP (DP-7); increments on every write
 * @param expiresAt absolute expiry, or {@code null} when the row never expires
 */
record PluginKvRow(String key, String valueJson, long version, Instant expiresAt) {
}
