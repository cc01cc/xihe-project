package com.cc01cc.p.xihe.cp.plugin;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;

/**
 * PLAN-0691 T2.2: one index declared by a plugin manifest
 * (spec/manifest.schema.json {@code $defs/index}, projected out of {@code storage.collections[]}).
 *
 * <p>This record is the <b>only</b> input the executor accepts; it deliberately carries no SQL. The
 * physical index name and the statement text are derived from it inside
 * {@link PluginIndexNaming}/{@link PluginIndexDdlExecutor}, so a manifest can never contribute a raw
 * identifier to a {@code CREATE INDEX} statement (spec/data-plane.md DP-2 "只建 manifest 声明索引").</p>
 *
 * <p>Declarations are projected from the persisted manifest document rather than re-parsed from the
 * package on the floor, so what gets indexed is exactly what digest verification covered.</p>
 */
public record PluginIndexDeclaration(String collection, String name, List<String> fields,
        boolean unique) {

    public PluginIndexDeclaration {
        fields = fields == null ? List.of() : List.copyOf(fields);
    }

    /**
     * Projects {@code storage.collections[].indexes[]} out of a validated manifest document.
     *
     * <p>A manifest without {@code storage}, or with collections that declare no indexes, yields an
     * empty list: the executor then does nothing, which is the "plugin stores nothing" default.</p>
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
            for (JsonNode index : collection.path("indexes")) {
                List<String> fields = new ArrayList<>();
                for (JsonNode field : index.path("fields")) {
                    fields.add(field.asText());
                }
                declarations.add(new PluginIndexDeclaration(collectionName,
                        index.path("name").asText(""), fields,
                        index.path("unique").asBoolean(false)));
            }
        }
        return declarations;
    }
}
