#!/usr/bin/env node
/**
 * PLAN-0666: refresh the sanitized real-data fixture used by
 * `ContextFingerprintRealDataTest` (verify V1.4: two independent JVMs must agree).
 *
 * The point of using a **real** `context_projections.payload` is that PostgreSQL `jsonb` does not
 * preserve insertion order — it rewrites object keys (length-then-byte order). A hand-built fixture
 * cannot reproduce that drift, which is exactly the failure mode design D6 is guarding against.
 *
 * The fixture must not carry local chat content or identifiers, so every value is sanitized
 * deterministically (same input → same output):
 *   - content-like strings become "x" repeated (capped), keeping the *shape* and rough size;
 *   - UUID values become stable placeholders, preserving uniqueness;
 *   - long opaque strings (paths/hashes) are capped;
 *   - keys and structure are untouched, including the jsonb-rewritten key order.
 *
 * Usage (from `packages/control-plane`, needs the dev PG running):
 *   docker exec a03-xihe-postgres-1 psql -U xihe -d xihe_1 -t -A \
 *     -c "SELECT payload::text FROM context_projections ORDER BY updated_at DESC LIMIT 1" \
 *     > /tmp/projection.json
 *   node src/test/scripts/refresh-context-fingerprint-fixture.mjs /tmp/projection.json \
 *     src/test/resources/context-fingerprint/real-projection.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CONTENT_KEYS = new Set([
    'content', 'rendered_text', 'text', 'message', 'prompt', 'arguments', 'result',
]);
const OPAQUE_KEYS = new Set([
    'path', 'source_hash', 'baseline_hash', 'hash', 'call_id', 'tool_call_id', 'branch_id',
    'aggregate_id', 'session_id', 'workspace_id', 'user_id', 'run_id', 'id',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_STRING = 96;

export function sanitize(value, key = '') {
    if (Array.isArray(value)) {
        return value.map((item) => sanitize(item));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [field, child] of Object.entries(value)) {
            out[field] = sanitize(child, field);
        }
        return out;
    }
    if (typeof value !== 'string') {
        return value;
    }
    if (CONTENT_KEYS.has(key)) {
        return 'x'.repeat(Math.min(Math.max(value.length, 1), MAX_STRING));
    }
    if (UUID.test(value)) {
        const digits = [...value.replace(/-/gu, '')].reduce((sum, ch) => (sum * 33 + ch.charCodeAt(0)) % 100000, 0);
        return `00000000-0000-4000-8000-${String(digits).padStart(12, '0')}`;
    }
    if (OPAQUE_KEYS.has(key) || value.length > MAX_STRING) {
        return 'x'.repeat(MAX_STRING);
    }
    return value;
}

if (process.argv[1] && process.argv[1].endsWith('refresh-context-fingerprint-fixture.mjs')) {
    const [, , input, output] = process.argv;
    if (!input || !output) {
        console.error('usage: node refresh-context-fingerprint-fixture.mjs <projection.json> <out.json>');
        process.exit(2);
    }
    const raw = JSON.parse(readFileSync(input, 'utf8'));
    writeFileSync(output, `${JSON.stringify(sanitize(raw), null, 2)}\n`, 'utf8');
    console.log(`sanitized fixture written: ${output}`);
}
