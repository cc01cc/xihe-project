package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;

import java.io.IOException;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * PLAN-0691 T1.1 (spec/manifest-rules.md §1): the manifest validation chain.
 *
 * <p>Order is fixed and fail-closed: JSON parse (≤256 KiB) → JSON-Schema shape (draft 2020-12 with
 * {@code additionalProperties=false}) → cross-field semantics (§2) → digest recompute (§3) →
 * source-directory/allowlist/`compatibility.xhApi` (§4). Every failure is one 422
 * {@code PLUGIN_MANIFEST_INVALID} — install never guesses or repairs a manifest.</p>
 *
 * <p>The schema itself is a fixed file in {@code plans/PLAN-0691-XH-plugin-mechanism/spec/}; this
 * class is the executable twin of that file for the fields the registry actually reads. The digest
 * uses the canonical form §3 freezes: keys sorted by Unicode code point, compact separators, no
 * top-level {@code digest}.</p>
 */
public final class PluginManifestValidator {

    public static final int MAX_MANIFEST_BYTES = 262_144;
    public static final String ERROR_CODE = "PLUGIN_MANIFEST_INVALID";

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    private static final Pattern ID_PATTERN =
            Pattern.compile("^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$");
    private static final Pattern SEMVER_PATTERN =
            Pattern.compile("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$");
    private static final Pattern DIGEST_PATTERN = Pattern.compile("^sha256:[a-f0-9]{64}$");
    private static final Pattern XH_API_PATTERN =
            Pattern.compile("^(>=|\\^|~)?[0-9]+\\.[0-9]+(\\.[0-9]+)?$");
    private static final Pattern ENDPOINT_PATTERN = Pattern.compile("^https?://[^\\s]+$");
    private static final Pattern ACTION_NAME_PATTERN = Pattern.compile("^[a-z][a-z0-9_.-]{0,63}$");
    private static final Pattern ATOM_NAME_PATTERN = Pattern.compile("^[a-z][a-z0-9_]{0,31}$");
    private static final Pattern CONTENT_TYPE_PATTERN = Pattern.compile("^[a-z]+/[a-z0-9.+-]+$");

    private static final Set<String> TOP_FIELDS = Set.of("manifestVersion", "id", "title",
            "description", "version", "digest", "source", "runtime", "actions", "requestedAtoms",
            "limits", "storage", "compatibility");
    private static final Set<String> TOP_REQUIRED = Set.of("manifestVersion", "id", "version",
            "digest", "runtime", "actions", "requestedAtoms", "compatibility");

    private static final Set<String> HTTP_FIELDS = Set.of("kind", "endpoint");
    private static final Set<String> STDIO_FIELDS = Set.of("kind", "command", "args", "workdir");
    private static final Set<String> ACTION_FIELDS = Set.of("name", "title", "actionClass",
            "resourceType");
    private static final Set<String> LIMITS_FIELDS = Set.of("timeoutMs", "maxConcurrency");
    private static final Set<String> STORAGE_FIELDS = Set.of("kv", "collections", "blobs");
    private static final Set<String> KV_FIELDS = Set.of("namespaces", "maxKeys", "maxValueBytes",
            "ttlSecondsMax");
    private static final Set<String> COLLECTION_FIELDS = Set.of("name", "docBytesMax", "fields",
            "indexes");
    private static final Set<String> INDEX_FIELDS = Set.of("name", "fields", "unique");
    private static final Set<String> BLOBS_FIELDS = Set.of("maxBytes", "contentTypes");

    private static final Set<String> ATOM_VALUES = Set.of("plugin:manage", "plugin:bind",
            "plugin:invoke", "plugin:data");
    private static final Set<String> ACTION_CLASSES = Set.of("read", "write", "exec", "network");

    private static final int MAX_INDEXES_PER_PLUGIN = 12;

    private PluginManifestValidator() {}

    /**
     * Validates {@code rawBytes} against the frozen schema and returns the registry projection.
     *
     * @param expectedSource the source directory the package was read from ({@code builtin} or
     *                       {@code third-party}); B-3 rechecks the declared {@code source} against
     *                       it and applies the {@code official.} prefix rule.
     * @throws CpApiException 422 {@code PLUGIN_MANIFEST_INVALID} on the first failure
     */
    public static PluginManifest validate(byte[] rawBytes, String expectedSource) {
        if (rawBytes == null || rawBytes.length == 0) {
            throw invalid("manifest is empty");
        }
        if (rawBytes.length > MAX_MANIFEST_BYTES) {
            throw invalid("manifest exceeds " + MAX_MANIFEST_BYTES + " bytes");
        }
        JsonNode root;
        try {
            root = MAPPER.readTree(rawBytes);
        } catch (IOException e) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, ERROR_CODE,
                    "manifest is not valid JSON", e);
        }
        if (!root.isObject()) {
            throw invalid("manifest must be a JSON object");
        }
        requireObject(root, "$", TOP_FIELDS, TOP_REQUIRED);

        String manifestVersion = requireField(root, "manifestVersion", 1, 16, null);
        if (!"1".equals(manifestVersion)) {
            throw invalid("manifestVersion must be \"1\"");
        }

        String id = requireField(root, "id", 1, 128, ID_PATTERN);
        String version = requireField(root, "version", 1, 64, SEMVER_PATTERN);
        String digest = requireField(root, "digest", 1, 80, DIGEST_PATTERN);
        optionalText(root, "title", 1, 80, null);
        optionalText(root, "description", 0, 800, null);

        String declaredSource = optionalText(root, "source", 1, 16, null);
        if (declaredSource != null) {
            if (!Plugin.SOURCE_BUILTIN.equals(declaredSource)
                    && !Plugin.SOURCE_THIRD_PARTY.equals(declaredSource)) {
                throw invalid("source must be builtin or third-party");
            }
            if (!declaredSource.equals(expectedSource)) {
                throw invalid("source " + declaredSource + " does not match the package directory");
            }
        }
        boolean builtin = Plugin.SOURCE_BUILTIN.equals(expectedSource);
        if (builtin && !id.startsWith("official.")) {
            throw invalid("a builtin plugin id must start with official.");
        }
        if (!builtin && id.startsWith("official.")) {
            throw invalid("the official. prefix is reserved for builtin packages");
        }

        String runtimeKind = validateRuntime(root.get("runtime"));
        List<PluginManifest.Action> actions = validateActions(root.get("actions"));
        List<String> requestedAtoms = validateRequestedAtoms(root.get("requestedAtoms"));
        PluginManifest.Limits limits = validateLimits(root.get("limits"));
        validateStorage(root.get("storage"));
        validateCompatibility(root.get("compatibility"));

        String computed = computeDigest(root);
        if (!computed.equals(digest)) {
            throw invalid("digest mismatch: manifest declares " + digest + " but canonical form is "
                    + computed);
        }
        String effectiveSource = declaredSource == null ? expectedSource : declaredSource;
        return new PluginManifest(id, version, digest, effectiveSource, manifestVersion, actions,
                requestedAtoms, limits, root);
    }

    /** §3: {@code sha256:} + lowercase hex over the canonical JSON (top-level digest excluded). */
    public static String computeDigest(JsonNode manifest) {
        ObjectNode canonical = manifest.deepCopy();
        canonical.remove("digest");
        String json = canonicalJson(canonical);
        return "sha256:" + sha256Hex(json.getBytes(StandardCharsets.UTF_8));
    }

    /** True when {@code candidate} is a strictly greater semantic version than {@code current}. */
    public static boolean isNewerVersion(String candidate, String current) {
        int[] left = versionNumbers(candidate);
        int[] right = versionNumbers(current);
        for (int i = 0; i < Math.min(left.length, right.length); i++) {
            if (left[i] != right[i]) {
                return left[i] > right[i];
            }
        }
        return left.length > right.length;
    }

    private static int[] versionNumbers(String version) {
        return version.split("-")[0].split("\\.").length == 0 ? new int[0] : java.util.Arrays.stream(
                version.split("-")[0].split("\\.")).mapToInt(Integer::parseInt).toArray();
    }

    private static String validateRuntime(JsonNode runtime) {
        if (!runtime.isObject()) {
            throw invalid("runtime must be an object");
        }
        String kind = requireField(runtime, "kind", 1, 32, null);
        if ("mcp-http".equals(kind)) {
            requireObject(runtime, "runtime", HTTP_FIELDS, Set.of("kind", "endpoint"));
            requireValue(runtime.get("endpoint"), "runtime.endpoint", 1, 512, ENDPOINT_PATTERN);
            return kind;
        }
        if ("mcp-stdio".equals(kind)) {
            requireObject(runtime, "runtime", STDIO_FIELDS, Set.of("kind", "command"));
            requireValue(runtime.get("command"), "runtime.command", 1, 256, null);
            JsonNode args = runtime.get("args");
            if (args != null && !args.isNull()) {
                if (!args.isArray()) {
                    throw invalid("runtime.args must be an array");
                }
                if (args.size() > 32) {
                    throw invalid("runtime.args allows at most 32 entries");
                }
                for (JsonNode arg : args) {
                    if (!arg.isTextual() || arg.asText().length() > 512) {
                        throw invalid("runtime.args entries must be strings of at most 512 chars");
                    }
                }
            }
            JsonNode workdir = runtime.get("workdir");
            if (workdir != null && !workdir.isNull()) {
                if (!workdir.isTextual() || workdir.asText().length() > 256) {
                    throw invalid("runtime.workdir must be a string of at most 256 chars");
                }
            }
            return kind;
        }
        throw invalid("runtime.kind must be mcp-http or mcp-stdio");
    }

    private static List<PluginManifest.Action> validateActions(JsonNode actions) {
        if (!actions.isArray()) {
            throw invalid("actions must be an array");
        }
        if (actions.size() < 1 || actions.size() > 64) {
            throw invalid("actions must declare 1 to 64 entries");
        }
        Set<String> names = new HashSet<>();
        List<PluginManifest.Action> parsed = new ArrayList<>();
        for (int i = 0; i < actions.size(); i++) {
            JsonNode action = actions.get(i);
            if (!action.isObject()) {
                throw invalid("actions[" + i + "] must be an object");
            }
            requireObject(action, "actions[" + i + "]", ACTION_FIELDS, Set.of("name", "actionClass"));
            String name = requireField(action, "name", 1, 64, ACTION_NAME_PATTERN);
            if (name.startsWith("sys_") || name.startsWith("_")) {
                throw invalid("actions[" + i + "].name uses a reserved prefix");
            }
            if (!names.add(name)) {
                throw invalid("action names must be unique: " + name);
            }
            String title = optionalText(action, "title", 0, 80, null);
            String actionClass = requireField(action, "actionClass", 1, 16, null);
            if (!ACTION_CLASSES.contains(actionClass)) {
                throw invalid("actions[" + i + "].actionClass must be read|write|exec|network");
            }
            String resourceType = optionalText(action, "resourceType", 1, 32,
                    ATOM_NAME_PATTERN);
            parsed.add(new PluginManifest.Action(name, title, actionClass, resourceType));
        }
        return parsed;
    }

    private static List<String> validateRequestedAtoms(JsonNode atoms) {
        if (!atoms.isArray()) {
            throw invalid("requestedAtoms must be an array");
        }
        if (atoms.size() > 4) {
            throw invalid("requestedAtoms allows at most 4 entries");
        }
        List<String> parsed = new ArrayList<>();
        for (int i = 0; i < atoms.size(); i++) {
            JsonNode atom = atoms.get(i);
            if (!atom.isTextual() || !ATOM_VALUES.contains(atom.asText())) {
                throw invalid("requestedAtoms[" + i + "] must be one of " + ATOM_VALUES);
            }
            if (parsed.contains(atom.asText())) {
                throw invalid("requestedAtoms must be unique");
            }
            parsed.add(atom.asText());
        }
        return parsed;
    }

    private static PluginManifest.Limits validateLimits(JsonNode limits) {
        int timeoutMs = 5000;
        int maxConcurrency = 4;
        if (limits == null || limits.isNull()) {
            return new PluginManifest.Limits(timeoutMs, maxConcurrency);
        }
        if (!limits.isObject()) {
            throw invalid("limits must be an object");
        }
        rejectUnknownFields(limits, "limits", LIMITS_FIELDS);
        timeoutMs = integer(limits, "timeoutMs", 1000, 60000, timeoutMs);
        maxConcurrency = integer(limits, "maxConcurrency", 1, 32, maxConcurrency);
        return new PluginManifest.Limits(timeoutMs, maxConcurrency);
    }

    private static void validateStorage(JsonNode storage) {
        if (storage == null || storage.isNull()) {
            return;
        }
        if (!storage.isObject()) {
            throw invalid("storage must be an object");
        }
        rejectUnknownFields(storage, "storage", STORAGE_FIELDS);
        validateKv(storage.get("kv"));
        validateCollections(storage.get("collections"));
        validateBlobs(storage.get("blobs"));
    }

    private static void validateKv(JsonNode kv) {
        if (kv == null || kv.isNull()) {
            return;
        }
        if (!kv.isObject()) {
            throw invalid("storage.kv must be an object");
        }
        rejectUnknownFields(kv, "storage.kv", KV_FIELDS);
        JsonNode namespaces = kv.get("namespaces");
        if (namespaces != null && !namespaces.isNull()) {
            if (!namespaces.isArray() || namespaces.size() < 1 || namespaces.size() > 8) {
                throw invalid("storage.kv.namespaces must declare 1 to 8 entries");
            }
            Set<String> seen = new HashSet<>();
            int index = 0;
            for (JsonNode namespace : namespaces) {
                requireValue(namespace, "storage.kv.namespaces[" + index + "]", 1, 32,
                        ATOM_NAME_PATTERN);
                if (!seen.add(namespace.asText())) {
                    throw invalid("storage.kv.namespaces must be unique");
                }
                index++;
            }
        }
        integer(kv, "maxKeys", 1, 20000, 10000);
        integer(kv, "maxValueBytes", 1, 262144, 65536);
        integer(kv, "ttlSecondsMax", 60, 7_776_000, 2_592_000);
    }

    private static void validateCollections(JsonNode collections) {
        if (collections == null || collections.isNull()) {
            return;
        }
        if (!collections.isArray()) {
            throw invalid("storage.collections must be an array");
        }
        if (collections.size() > 8) {
            throw invalid("storage.collections allows at most 8 entries");
        }
        Set<String> names = new HashSet<>();
        int totalIndexes = 0;
        for (int i = 0; i < collections.size(); i++) {
            JsonNode collection = collections.get(i);
            String path = "storage.collections[" + i + "]";
            if (!collection.isObject()) {
                throw invalid(path + " must be an object");
            }
            requireObject(collection, path, COLLECTION_FIELDS, Set.of("name", "fields"));
            String name = requireField(collection, "name", 1, 32, ATOM_NAME_PATTERN);
            if (!names.add(name)) {
                throw invalid("storage.collections names must be unique: " + name);
            }
            integer(collection, "docBytesMax", 1, 1_048_576, 262_144);
            List<String> fields = stringList(collection.get("fields"), path + ".fields", 1, 8,
                    ATOM_NAME_PATTERN);
            totalIndexes += validateIndexes(collection.get("indexes"), path, name, fields);
        }
        if (totalIndexes > MAX_INDEXES_PER_PLUGIN) {
            throw invalid("declared indexes exceed " + MAX_INDEXES_PER_PLUGIN + " per plugin");
        }
    }

    private static int validateIndexes(JsonNode indexes, String path, String collectionName,
            List<String> declaredFields) {
        if (indexes == null || indexes.isNull()) {
            return 0;
        }
        if (!indexes.isArray()) {
            throw invalid(path + ".indexes must be an array");
        }
        if (indexes.size() > 4) {
            throw invalid(path + ".indexes allows at most 4 entries");
        }
        Set<String> names = new HashSet<>();
        for (int i = 0; i < indexes.size(); i++) {
            JsonNode index = indexes.get(i);
            JsonNode indexPath = indexes.get(i);
            String label = path + ".indexes[" + i + "]";
            if (!index.isObject()) {
                throw invalid(label + " must be an object");
            }
            requireObject(index, label, INDEX_FIELDS, Set.of("name", "fields"));
            String name = requireField(index, "name", 1, 32, ATOM_NAME_PATTERN);
            if (!names.add(name)) {
                throw invalid(label + ".name must be unique within " + collectionName);
            }
            List<String> fields = stringList(index.get("fields"), label + ".fields", 1, 4,
                    ATOM_NAME_PATTERN);
            for (String field : fields) {
                if (!declaredFields.contains(field)) {
                    throw invalid(label + ".fields references undeclared field " + field);
                }
            }
            JsonNode unique = index.get("unique");
            if (unique != null && !unique.isNull() && !unique.isBoolean()) {
                throw invalid(label + ".unique must be a boolean");
            }
            if (indexPath == null) {
                throw invalid(label + " is missing");
            }
        }
        return indexes.size();
    }

    private static void validateBlobs(JsonNode blobs) {
        if (blobs == null || blobs.isNull()) {
            return;
        }
        if (!blobs.isObject()) {
            throw invalid("storage.blobs must be an object");
        }
        rejectUnknownFields(blobs, "storage.blobs", BLOBS_FIELDS);
        integer(blobs, "maxBytes", 1, 1_073_741_824, 104_857_600);
        JsonNode contentTypes = blobs.get("contentTypes");
        if (contentTypes != null && !contentTypes.isNull()) {
            if (!contentTypes.isArray() || contentTypes.size() > 16) {
                throw invalid("storage.blobs.contentTypes allows at most 16 entries");
            }
            for (JsonNode contentType : contentTypes) {
                if (!contentType.isTextual()
                        || !CONTENT_TYPE_PATTERN.matcher(contentType.asText()).matches()) {
                    throw invalid("storage.blobs.contentTypes entries must be mime types");
                }
            }
        }
    }

    private static void validateCompatibility(JsonNode compatibility) {
        if (!compatibility.isObject()) {
            throw invalid("compatibility must be an object");
        }
        requireObject(compatibility, "compatibility", Set.of("xhApi"), Set.of("xhApi"));
        requireValue(compatibility.get("xhApi"), "compatibility.xhApi", 1, 16, XH_API_PATTERN);
    }

    private static List<String> stringList(JsonNode node, String path, int min, int max,
            Pattern pattern) {
        if (!node.isArray()) {
            throw invalid(path + " must be an array");
        }
        if (node.size() < min || node.size() > max) {
            throw invalid(path + " allows " + min + " to " + max + " entries");
        }
        List<String> values = new ArrayList<>();
        for (int i = 0; i < node.size(); i++) {
            String value = requireValue(node.get(i), path + "[" + i + "]", 1, 32, pattern);
            if (values.contains(value)) {
                throw invalid(path + " must be unique");
            }
            values.add(value);
        }
        return values;
    }

    private static void requireObject(JsonNode node, String path, Set<String> allowed,
            Set<String> required) {
        if (!node.isObject()) {
            throw invalid(path + " must be an object");
        }
        rejectUnknownFields(node, path, allowed);
        List<String> missing = new ArrayList<>();
        for (String field : required) {
            if (node.has(field)) {
                continue;
            }
            missing.add(field);
        }
        if (!missing.isEmpty()) {
            throw invalid(path + " is missing required fields " + missing);
        }
    }

    private static void rejectUnknownFields(JsonNode node, String path, Set<String> allowed) {
        node.fieldNames().forEachRemaining(field -> {
            if (!allowed.contains(field)) {
                throw invalid(path + " has unknown field " + field);
            }
        });
    }

    /**
     * Reads a <b>named field</b> of {@code node} as text. Separate from {@link #requireValue}
     * on purpose: both used to be overloads of one name, and since every caller passes a
     * {@link JsonNode}, Java always picked the value overload — so the root object itself was
     * checked for being textual and every manifest failed with "manifestVersion must be a string".
     */
    private static String requireField(JsonNode node, String field, int min, int max,
            Pattern pattern) {
        JsonNode value = node == null ? null : node.get(field);
        if (value == null || value.isNull()) {
            throw invalid(field + " is required");
        }
        return requireValue(value, field, min, max, pattern);
    }

    private static String requireValue(JsonNode value, String path, int min, int max,
            Pattern pattern) {
        if (value == null || value.isNull() || !value.isTextual()) {
            throw invalid(path + " must be a string");
        }
        String text = value.asText();
        if (text.length() < min || text.length() > max) {
            throw invalid(path + " length must be between " + min + " and " + max);
        }
        if (pattern != null && !pattern.matcher(text).matches()) {
            throw invalid(path + " does not match " + pattern.pattern());
        }
        return text;
    }

    private static String optionalText(Object node, String field, int min, int max, Pattern pattern) {
        JsonNode value = node instanceof JsonNode json ? json.get(field) : null;
        if (value == null || value.isNull()) {
            return null;
        }
        return requireValue(value, field, min, max, pattern);
    }

    private static int integer(Object node, String field, int min, int max, int defaultValue) {
        JsonNode value = node instanceof JsonNode json ? json.get(field) : null;
        if (value == null || value.isNull()) {
            return defaultValue;
        }
        if (!value.isIntegralNumber()) {
            throw invalid(field + " must be an integer");
        }
        long number = value.asLong();
        if (number < min || number > max) {
            throw invalid(field + " must be between " + min + " and " + max);
        }
        return (int) number;
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, ERROR_CODE, detail);
    }

    private static String canonicalJson(JsonNode node) {
        JsonFactory factory = MAPPER.getFactory();
        StringWriter writer = new StringWriter();
        try (JsonGenerator generator = factory.createGenerator(writer)) {
            writeCanonical(generator, node);
        } catch (IOException e) {
            throw new IllegalStateException("cannot canonicalize plugin manifest", e);
        }
        return writer.toString();
    }

    private static void writeCanonical(JsonGenerator generator, JsonNode node) throws IOException {
        if (node.isObject()) {
            generator.writeStartObject();
            List<String> names = new ArrayList<>();
            node.fieldNames().forEachRemaining(names::add);
            names.sort(PluginManifestValidator::compareCodePoints);
            for (String name : names) {
                generator.writeFieldName(name);
                writeCanonical(generator, node.get(name));
            }
            generator.writeEndObject();
            return;
        }
        if (node.isArray()) {
            generator.writeStartArray();
            for (JsonNode child : node) {
                writeCanonical(generator, child);
            }
            generator.writeEndArray();
            return;
        }
        generator.writeTree(node);
    }

    /** §3 orders object keys by Unicode code point (String#compareTo is UTF-16 order). */
    static int compareCodePoints(String left, String right) {
        int i = 0;
        int j = 0;
        while (i < left.length() && j < right.length()) {
            int a = left.codePointAt(i);
            int b = right.codePointAt(j);
            if (a != b) {
                return a < b ? -1 : 1;
            }
            i += Character.charCount(a);
            j += Character.charCount(b);
        }
        return Integer.compare(left.length() - i, right.length() - j);
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(bytes);
            return hex(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            builder.append(String.format(Locale.ROOT, "%02x", value));
        }
        return builder.toString();
    }
}
