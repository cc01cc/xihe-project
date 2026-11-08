package com.cc01cc.p.xihe.cp.plugin;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * PLAN-0691 T2.2: one index declared by a plugin manifest
 * (spec/manifest.schema.json {@code $defs/index}, projected out of {@code storage.collections[]}).
 *
 * <p>This record is the <b>only</b> input the executor accepts; it deliberately carries no SQL. The
 * physical index name and the statement text are derived from it inside
 * {@link PluginIndexNaming}/{@link PluginIndexDdlExecutor}, so a manifest can never contribute a raw
 * identifier to a {@code CREATE INDEX} statement (spec/data-plane.md DP-2 "只建 manifest 声明索引").</p>
 *
 * <p><b>Field types (PLAN-0691 §5.2):</b> {@code storage.collections[].fields[]} is an object array
 * of {@code {name, type}} — not the string array that shipped before — and the type is what selects
 * the index expression (spec/data-plane.md DP-2: {@code string} and {@code date} stay text,
 * {@code number} ⇒ {@code ::numeric}, {@code boolean} ⇒ {@code ::boolean}, because an untyped
 * {@code ->>} compares lexicographically and would order {@code "10" < "9"}). {@code date} keeps the
 * text form because a {@code timestamptz} cast is not indexable ({@code timestamptz_in} is
 * {@code STABLE}, so PostgreSQL refuses it) and the type is stored as a normalized fixed-width UTC
 * instant, which orders as text exactly as it orders in time. The ledger still stores <b>names
 * only</b> (DP-3: the manifest is the single source of field types), so {@link #fieldNames()} is the
 * persisted form and the type must be re-read from the manifest on every install. A type change is
 * therefore an index-definition change — {@code CREATE INDEX IF NOT EXISTS} would silently keep the
 * old cast, so the executor compares the physical expression against the declaration and rebuilds
 * under the same stable name. The exception is the {@code string}⇄{@code date} pair, whose physical
 * expressions are identical: ruling C1 (2026-11-08) accepts that swap without any rebuild or rename
 * (there is no physical object to change), and only the write-side form check changes with it.</p>
 *
 * <p>Declarations are projected from the persisted manifest document rather than re-parsed from the
 * package on the floor, so what gets indexed is exactly what digest verification covered.</p>
 */
public record PluginIndexDeclaration(String collection, String name, List<DeclaredField> fields,
        boolean unique) {

    /** The four frozen scalar types of PLAN-0691 §5.2; no other value is legal in a manifest. */
    public static final Set<String> FIELD_TYPES = Set.of("string", "number", "boolean", "date");

    /**
     * One declared collection field: the manifest name plus the frozen type that decides its cast.
     *
     * @throws IllegalArgumentException when the name is blank or the type falls outside
     *     {@link #FIELD_TYPES} — a declaration never carries an undefined cast
     */
    public record DeclaredField(String name, String type) {

        public DeclaredField {
            if (name == null || name.isBlank()) {
                throw new IllegalArgumentException("declared field name is required");
            }
            if (type == null || !FIELD_TYPES.contains(type)) {
                throw new IllegalArgumentException("undeclared plugin field type: " + type);
            }
        }
    }

    public PluginIndexDeclaration {
        fields = fields == null ? List.of() : List.copyOf(fields);
    }

    /** Field names in declaration order — exactly what {@code plugin_index_declarations} stores. */
    public List<String> fieldNames() {
        List<String> names = new ArrayList<>(fields.size());
        for (DeclaredField field : fields) {
            names.add(field.name());
        }
        return List.copyOf(names);
    }

    /**
     * Projects {@code storage.collections[].indexes[]} out of a validated manifest document.
     *
     * <p>A manifest without {@code storage}, or with collections that declare no indexes, yields an
     * empty list: the executor then does nothing, which is the "plugin stores nothing" default.</p>
     *
     * <p>An index field names a field the collection already declared as {@code {name, type}} — the
     * type comes from there, never from the index itself (schema: {@code $defs/index.fields} stays a
     * string array precisely so the two cannot disagree). The validator rejects an undeclared
     * reference, so a document that still carries one did not go through validation (hand-written or
     * pre-{@code {name,type}} data): such an index is <b>dropped</b> rather than given an invented
     * type, matching the "drop what verification did not cover" rule used for records.</p>
     */
    public static List<PluginIndexDeclaration> from(JsonNode manifest) {
        if (manifest == null) {
            return List.of();
        }
        JsonNode collections = manifest.path("storage").path("collections");
        if (!collections.isArray()) {
            return List.of();
        }
        List<PluginIndexDeclaration> declarations = new ArrayList<>();
        for (JsonNode collection : collections) {
            String collectionName = collection.path("name").asText("");
            List<DeclaredField> declared = declaredFields(collection.path("fields"));
            if (declared.isEmpty()) {
                continue;
            }
            for (JsonNode index : collection.path("indexes")) {
                List<DeclaredField> fields = referencedFields(index.path("fields"), declared);
                if (fields.isEmpty()) {
                    continue;
                }
                declarations.add(new PluginIndexDeclaration(collectionName,
                        index.path("name").asText(""), fields, index.path("unique").asBoolean(false)));
            }
        }
        return declarations;
    }

    /** The collection's declared fields, skipping entries outside the frozen {@code {name,type}} shape. */
    private static List<DeclaredField> declaredFields(JsonNode node) {
        List<DeclaredField> fields = new ArrayList<>();
        if (!node.isArray()) {
            return fields;
        }
        for (JsonNode field : node) {
            String name = field.path("name").asText("");
            String type = field.path("type").asText("");
            if (name.isEmpty() || !FIELD_TYPES.contains(type)) {
                continue;
            }
            fields.add(new DeclaredField(name, type));
        }
        return fields;
    }

    /** Resolves index field names against the declared fields; empty means at least one is unknown. */
    private static List<DeclaredField> referencedFields(JsonNode names, List<DeclaredField> declared) {
        List<DeclaredField> fields = new ArrayList<>();
        if (!names.isArray()) {
            return fields;
        }
        for (JsonNode name : names) {
            DeclaredField match = null;
            for (DeclaredField candidate : declared) {
                if (candidate.name().equals(name.asText(""))) {
                    match = candidate;
                    break;
                }
            }
            if (match == null) {
                return List.of();
            }
            fields.add(match);
        }
        return fields;
    }
}
