package com.cc01cc.p.xihe.cp.plugin.records;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * PLAN-0691 T2.3: the record-storage projection of a validated plugin manifest
 * (spec/manifest.schema.json {@code $defs/collection}, read out of {@code storage.collections[]}).
 *
 * <p>This is the <b>only</b> source of the query whitelist: a field name that is absent here is not
 * filterable and not sortable (spec/data-plane.md §5 API-12 "未声明字段" ⇒ 400 {@code INVALID_FILTER}).
 * It is projected from the persisted manifest document — the same bytes digest verification covered —
 * so the whitelist cannot disagree with what was installed (the pattern
 * {@code PluginIndexDeclaration.from} established in T2.2).
 *
 * <p>Jackson <b>2</b> on purpose: {@code plugins.manifest} is a Jackson-2 tree (the entity predates
 * PLAN-0633 C1), and nothing here reaches the wire. The document body of a record is Jackson 3 and
 * never passes through this class.
 *
 * <p>A manifest with no {@code storage}, or with no collections, projects to an empty schema: every
 * request then answers 404 {@code PLUGIN_NOT_FOUND}, which is the correct answer for "this plugin
 * declared no storage" — the same "declares nothing ⇒ does nothing" default as the index executor.
 */
public record PluginRecordSchema(Map<String, Collection> collections) {

    public PluginRecordSchema {
        collections = collections == null ? Map.of() : Map.copyOf(collections);
    }

    /**
     * One declared collection.
     *
     * @param name        manifest collection name (schema pattern {@code ^[a-z][a-z0-9_]{0,31}$})
     * @param fields      declared field names — the complete filter/sort whitelist
     * @param types       declared field type per name (the frozen four; absent for an unknown field)
     * @param docBytesMax per-collection document ceiling declared by the manifest, or {@code null}
     *                    when it does not declare one (then the CP ceiling QUOTA-7 applies)
     * @param indexes     declared indexes, carried for the write path's unique-conflict reporting
     */
    public record Collection(String name, Set<String> fields, Map<String, String> types,
            Integer docBytesMax, List<Index> indexes) {

        public Collection {
            fields = fields == null ? Set.of() : Set.copyOf(fields);
            types = types == null ? Map.of() : Map.copyOf(types);
            indexes = indexes == null ? List.of() : List.copyOf(indexes);
        }

        /** Name-only construction for callers that have no manifest behind them (query tests). */
        public Collection(String name, Set<String> fields, Integer docBytesMax, List<Index> indexes) {
            this(name, fields, Map.of(), docBytesMax, indexes);
        }

        /** True when {@code field} is declared, i.e. usable in a filter or as the sort key. */
        public boolean declares(String field) {
            return field != null && fields.contains(field);
        }

        /** The declared type of {@code field}, or {@code null} when the field is not declared. */
        public String typeOf(String field) {
            return field == null ? null : types.get(field);
        }
    }

    /** One declared index (schema {@code $defs/index}); {@code unique} drives the 409 surface. */
    public record Index(String name, List<String> fields, boolean unique) {
        public Index {
            fields = fields == null ? List.of() : List.copyOf(fields);
        }
    }

    /** Projects {@code storage.collections[]} out of a validated manifest document. */
    public static PluginRecordSchema from(JsonNode manifest) {
        if (manifest == null) {
            return new PluginRecordSchema(Map.of());
        }
        JsonNode declared = manifest.path("storage").path("collections");
        if (!declared.isArray()) {
            return new PluginRecordSchema(Map.of());
        }
        Map<String, Collection> collections = new LinkedHashMap<>();
        for (JsonNode node : declared) {
            String name = node.path("name").asText("");
            if (name.isEmpty()) {
                // The install-time validator rejects an unnamed collection (QUOTA-8/422); reaching
                // here with an empty name means the stored document was not validated by CP, so the
                // safe projection is to drop it rather than create a collection addressable by "".
                continue;
            }
            Set<String> fields = new LinkedHashSet<>();
            Map<String, String> types = new LinkedHashMap<>();
            for (JsonNode field : node.path("fields")) {
                // PLAN-0691 §5.2: a declared field is {name, type}, not a bare string. The query
                // whitelist only needs the name, but the write path needs the type too: a declared
                // `date` must be rejected unless it is a normalized fixed-width UTC instant (the
                // index orders that type as text). asText() on the object form returns "" and would
                // silently declare nothing — every write would then be rejected as "undeclared field".
                String value = field.path("name").asText("");
                if (!value.isEmpty()) {
                    fields.add(value);
                    String type = field.path("type").asText("");
                    if (!type.isEmpty()) {
                        types.put(value, type);
                    }
                }
            }
            JsonNode declaredBytes = node.path("docBytesMax");
            Integer docBytesMax = declaredBytes.isNumber() ? declaredBytes.asInt() : null;
            List<Index> indexes = new ArrayList<>();
            for (JsonNode index : node.path("indexes")) {
                List<String> indexFields = new ArrayList<>();
                for (JsonNode field : index.path("fields")) {
                    indexFields.add(field.asText(""));
                }
                indexes.add(new Index(index.path("name").asText(""), indexFields,
                        index.path("unique").asBoolean(false)));
            }
            collections.put(name, new Collection(name, fields, types, docBytesMax, indexes));
        }
        return new PluginRecordSchema(collections);
    }

    /** The collection named on the wire, or empty when the manifest never declared it. */
    public Optional<Collection> find(String name) {
        return name == null ? Optional.empty() : Optional.ofNullable(collections.get(name));
    }
}
