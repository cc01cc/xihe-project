package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipException;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * task-84 (DSD-1480): the zip bundle is the primary shape for configuration transport; the single
 * JSONC endpoints stay as the compatibility light path and are not touched by this class.
 *
 * <p>Card 2 scope ("the minimum vertical slice"): a bundle carries exactly two entries —
 * {@code manifest.json} and {@code config/instance.jsonc}. The JSONC payload is <em>not</em>
 * re-serialised here: {@link #exportBundle(boolean)} calls {@link ConfigService#exportJsonc} and
 * stores its existing bytes verbatim, and the manifest records that byte length and sha256.
 *
 * <p>Import is verify-then-write: every structural check (entry names, symlink flag, entry count,
 * per-entry and total byte caps, manifest presence/version, file set equality, per-file sha256 and
 * byte length) runs before a single config row is touched, so a rejected bundle is a zero-write
 * no-op. The import itself goes through {@link ConfigService#importJsonc}, which keeps the existing
 * semantics (env-locked and admin-locked keys skipped with warnings, provider connections never
 * restored — DSD-1482).
 *
 * <p>Zero new dependencies: only {@code java.util.zip} from the JDK. The repository had no zip
 * usage before this class (design evidence 2026-11-20-config-bundle-design: grep
 * ZipOutputStream|ZipInputStream|GZIPOutputStream|java.util.zip = 0 hits).
 */
@Service
public class ConfigBundleService {

    private static final Logger log = LoggerFactory.getLogger(ConfigBundleService.class);

    public static final String MANIFEST_ENTRY = "manifest.json";
    public static final String CONFIG_ENTRY = "config/instance.jsonc";

    /** Only bundle shape this slice can read; bump together with the manifest writer. */
    public static final int FORMAT_VERSION = 1;
    public static final String LAYER_INSTANCE = "instance";

    /** Bounded bundle: this slice owns one payload file, so the caps are deliberately tight. */
    public static final int MAX_ENTRIES = 32;
    /** Same 1 MiB semantic the single JSONC import already uses (ConfigController#importConfig). */
    public static final int MAX_ENTRY_BYTES = 1_048_576;
    public static final int MAX_TOTAL_BYTES = 4 * 1_048_576;
    /**
     * Compressed upload cap. Kept at 1 MiB because Spring Boot's multipart default is 1 MiB per
     * part and this module does not configure {@code spring.servlet.multipart.*}; raising this
     * constant alone would move the failure from a typed 413 to an untyped multipart 500.
     */
    public static final int MAX_BUNDLE_BYTES = 1_048_576;

    private static final Pattern SHA256_HEX = Pattern.compile("^[0-9a-f]{64}$");

    private static final int ZIP_EOCD_SIG = 0x06054b50;
    private static final int ZIP_CENTRAL_SIG = 0x02014b50;
    private static final int ZIP_EOCD_MIN = 22;
    private static final int ZIP_EOCD_MAX_COMMENT = 0xFFFF;
    private static final int UNIX_MODE_SYMLINK = 0xA000;

    private final ConfigService configService;
    private final ObjectMapper objectMapper;

    public ConfigBundleService(ConfigService configService, ObjectMapper objectMapper) {
        this.configService = configService;
        this.objectMapper = objectMapper;
    }

    // ------------------------------------------------------------------
    // Export
    // ------------------------------------------------------------------

    /** Builds the bundle from the existing JSONC export product; never re-serialises config. */
    public byte[] exportBundle(boolean includeSecrets) {
        String jsonc = configService.exportJsonc(LAYER_INSTANCE, null, null, includeSecrets);
        byte[] jsoncBytes = jsonc.getBytes(StandardCharsets.UTF_8);
        if (jsoncBytes.length > MAX_ENTRY_BYTES) {
            throw new CpApiException(HttpStatus.PAYLOAD_TOO_LARGE, "BUNDLE_ENTRY_TOO_LARGE",
                    "Exported config payload exceeds " + MAX_ENTRY_BYTES + " bytes; export the domains one by one");
        }

        ObjectNode manifest = objectMapper.createObjectNode();
        manifest.put("formatVersion", FORMAT_VERSION);
        manifest.put("createdAt", Instant.now().toString());
        manifest.put("layer", LAYER_INSTANCE);
        manifest.put("generator", "xihe-control-plane");
        manifest.put("includeSecrets", includeSecrets);
        ArrayNode files = manifest.putArray("files");
        ObjectNode fileNode = files.addObject();
        fileNode.put("path", CONFIG_ENTRY);
        fileNode.put("sha256", sha256Hex(jsoncBytes));
        fileNode.put("bytes", jsoncBytes.length);

        byte[] manifestBytes;
        try {
            manifestBytes = objectMapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(manifest);
        } catch (IOException e) {
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "BUNDLE_EXPORT_FAILED",
                    "Failed to serialise the bundle manifest", e);
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream(jsoncBytes.length + manifestBytes.length + 512);
        try (ZipOutputStream zip = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
            writeEntry(zip, MANIFEST_ENTRY, manifestBytes);
            writeEntry(zip, CONFIG_ENTRY, jsoncBytes);
        } catch (IOException e) {
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "BUNDLE_EXPORT_FAILED",
                    "Failed to build the bundle archive", e);
        }
        byte[] bundle = out.toByteArray();
        log.info("Config bundle exported: {} bytes, includeSecrets={}, entryBytes={}",
                bundle.length, includeSecrets, jsoncBytes.length);
        return bundle;
    }

    private static void writeEntry(ZipOutputStream zip, String name, byte[] data) throws IOException {
        ZipEntry entry = new ZipEntry(name);
        entry.setTime(0L);
        zip.putNextEntry(entry);
        zip.write(data);
        zip.closeEntry();
    }

    // ------------------------------------------------------------------
    // Import
    // ------------------------------------------------------------------

    /**
     * Verifies the bundle end to end and only then hands the embedded JSONC to the existing
     * importer. Any failure before that point leaves the config store untouched.
     */
    public ConfigService.ImportReport importBundle(byte[] bundle, UUID actorId) {
        if (bundle == null || bundle.length == 0) {
            throw invalid("EMPTY_BUNDLE", "Bundle upload is empty");
        }
        if (bundle.length > MAX_BUNDLE_BYTES) {
            throw new CpApiException(HttpStatus.PAYLOAD_TOO_LARGE, "BUNDLE_TOO_LARGE",
                    "Bundle archive exceeds " + MAX_BUNDLE_BYTES + " bytes");
        }

        Map<String, Integer> unixModes = unixEntryModes(bundle);
        Map<String, byte[]> files = readEntries(bundle, unixModes);
        if (files.isEmpty()) {
            // A payload that is not a readable zip yields no entries at all; saying "manifest
            // missing" would hide a transport mistake behind a contract mistake.
            throw invalid("INVALID_BUNDLE", "Payload is not a readable zip archive");
        }

        byte[] manifestBytes = files.remove(MANIFEST_ENTRY);
        if (manifestBytes == null) {
            throw invalid("MISSING_MANIFEST",
                    "Bundle must contain " + MANIFEST_ENTRY + "; refusing to guess files by name");
        }
        List<ManifestFile> declared = parseManifest(manifestBytes);

        Set<String> declaredPaths = new LinkedHashSet<>();
        for (ManifestFile file : declared) {
            if (!declaredPaths.add(file.path())) {
                throw invalid("INVALID_MANIFEST", "Manifest declares the same path twice: " + file.path());
            }
        }
        for (String actual : files.keySet()) {
            if (!declaredPaths.contains(actual)) {
                throw invalid("UNEXPECTED_BUNDLE_ENTRY",
                        "Bundle entry is not declared in the manifest: " + actual);
            }
        }
        for (ManifestFile file : declared) {
            byte[] data = files.get(file.path());
            if (data == null) {
                throw invalid("MISSING_BUNDLE_FILE",
                        "Manifest declares a file the archive does not contain: " + file.path());
            }
            if (!CONFIG_ENTRY.equals(file.path())) {
                throw invalid("UNSUPPORTED_BUNDLE_SECTION",
                        "Bundle section is not supported by this version: " + file.path());
            }
            String actualSha = sha256Hex(data);
            if (!actualSha.equals(file.sha256()) || data.length != file.bytes()) {
                throw invalid("MANIFEST_MISMATCH",
                        "Bundle file does not match the manifest: " + file.path()
                                + " (manifest sha256=" + file.sha256() + " bytes=" + file.bytes()
                                + ", actual sha256=" + actualSha + " bytes=" + data.length + ")");
            }
        }

        String jsonc = new String(files.get(CONFIG_ENTRY), StandardCharsets.UTF_8);
        try {
            ConfigService.ImportReport report = configService.importJsonc(
                    jsonc, LAYER_INSTANCE, null, null, actorId == null ? "bundle-import" : actorId.toString());
            log.info("Config bundle imported: imported={}, skipped={}, warnings={}",
                    report.imported(), report.skipped(), report.warnings().size());
            return report;
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_BUNDLE_CONFIG",
                    "Bundle config payload is not importable: " + e.getMessage(), e);
        }
    }

    private Map<String, byte[]> readEntries(byte[] bundle, Map<String, Integer> unixModes) {
        Map<String, byte[]> files = new LinkedHashMap<>();
        long total = 0;
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bundle), StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName();
                validateEntryName(name);
                Integer mode = unixModes.get(name);
                if (mode != null && (mode & 0xF000) == UNIX_MODE_SYMLINK) {
                    throw invalid("INVALID_BUNDLE_ENTRY", "Bundle entry must not be a symbolic link: " + name);
                }
                if (entry.isDirectory() || name.endsWith("/")) {
                    continue;
                }
                if (files.size() >= MAX_ENTRIES) {
                    throw invalid("TOO_MANY_BUNDLE_ENTRIES",
                            "Bundle contains more than " + MAX_ENTRIES + " file entries");
                }
                byte[] data = readBounded(zip, name);
                total += data.length;
                if (total > MAX_TOTAL_BYTES) {
                    throw new CpApiException(HttpStatus.PAYLOAD_TOO_LARGE, "BUNDLE_TOO_LARGE_UNCOMPRESSED",
                            "Bundle expands beyond " + MAX_TOTAL_BYTES + " bytes");
                }
                if (files.put(name, data) != null) {
                    throw invalid("DUPLICATE_BUNDLE_ENTRY", "Bundle contains the same entry twice: " + name);
                }
            }
        } catch (ZipException e) {
            throw invalid("INVALID_BUNDLE", "Bundle is not a readable zip archive");
        } catch (IOException e) {
            throw invalid("INVALID_BUNDLE", "Bundle could not be read: " + e.getMessage());
        }
        return files;
    }

    private static byte[] readBounded(ZipInputStream zip, String name) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = zip.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
            if (buffer.size() > MAX_ENTRY_BYTES) {
                throw new CpApiException(HttpStatus.PAYLOAD_TOO_LARGE, "BUNDLE_ENTRY_TOO_LARGE",
                        "Bundle entry exceeds " + MAX_ENTRY_BYTES + " bytes: " + name);
            }
        }
        return buffer.toByteArray();
    }

    /** Rejects absolute names, Windows separators, {@code .}/{@code ..} segments and NUL bytes. */
    private static void validateEntryName(String name) {
        if (name == null || name.isBlank()) {
            throw invalid("INVALID_BUNDLE_ENTRY", "Bundle entry name is blank");
        }
        if (name.indexOf('\u0000') >= 0) {
            throw invalid("INVALID_BUNDLE_ENTRY", "Bundle entry name contains a NUL byte");
        }
        if (name.indexOf('\\') >= 0) {
            throw invalid("INVALID_BUNDLE_ENTRY", "Bundle entry must use '/' separators: " + name);
        }
        if (name.startsWith("/")) {
            throw invalid("INVALID_BUNDLE_ENTRY", "Bundle entry must be relative: " + name);
        }
        if (name.length() > 1 && name.charAt(1) == ':') {
            throw invalid("INVALID_BUNDLE_ENTRY", "Bundle entry must not carry a drive letter: " + name);
        }
        for (String segment : name.split("/", -1)) {
            if ("..".equals(segment) || ".".equals(segment)) {
                throw invalid("INVALID_BUNDLE_ENTRY",
                        "Bundle entry must not contain dot segments: " + name);
            }
        }
    }

    private record ManifestFile(String path, String sha256, long bytes) {}

    private List<ManifestFile> parseManifest(byte[] manifestBytes) {
        JsonNode root;
        try {
            root = objectMapper.readTree(manifestBytes);
        } catch (IOException e) {
            throw invalid("INVALID_MANIFEST", "Manifest is not valid JSON");
        }
        if (root == null || !root.isObject()) {
            throw invalid("INVALID_MANIFEST", "Manifest must be a JSON object");
        }
        JsonNode version = root.get("formatVersion");
        if (version == null || !version.isIntegralNumber()) {
            throw invalid("INVALID_MANIFEST", "Manifest is missing an integer formatVersion");
        }
        if (version.asInt() != FORMAT_VERSION) {
            throw invalid("UNSUPPORTED_BUNDLE_VERSION",
                    "Unsupported bundle formatVersion " + version.asInt()
                            + "; this build reads " + FORMAT_VERSION);
        }
        JsonNode layer = root.get("layer");
        if (layer != null && layer.isTextual() && !LAYER_INSTANCE.equals(layer.asText())) {
            throw invalid("UNSUPPORTED_BUNDLE_LAYER",
                    "Only the instance layer can be imported, bundle declares " + layer.asText());
        }
        JsonNode filesNode = root.get("files");
        if (filesNode == null || !filesNode.isArray() || filesNode.isEmpty()) {
            throw invalid("INVALID_MANIFEST", "Manifest must declare a non-empty files array");
        }
        List<ManifestFile> files = new ArrayList<>();
        for (JsonNode node : filesNode) {
            if (!node.isObject()) {
                throw invalid("INVALID_MANIFEST", "Manifest file entries must be objects");
            }
            JsonNode pathNode = node.get("path");
            JsonNode shaNode = node.get("sha256");
            JsonNode bytesNode = node.get("bytes");
            if (pathNode == null || !pathNode.isTextual() || pathNode.asText().isBlank()) {
                throw invalid("INVALID_MANIFEST", "Manifest file entry is missing a path");
            }
            String path = pathNode.asText();
            validateEntryName(path);
            if (shaNode == null || !shaNode.isTextual() || !SHA256_HEX.matcher(shaNode.asText()).matches()) {
                throw invalid("INVALID_MANIFEST", "Manifest sha256 must be 64 lowercase hex chars: " + path);
            }
            if (bytesNode == null || !bytesNode.isIntegralNumber() || bytesNode.asLong() < 0) {
                throw invalid("INVALID_MANIFEST", "Manifest bytes must be a non-negative integer: " + path);
            }
            files.add(new ManifestFile(path, shaNode.asText(), bytesNode.asLong()));
        }
        return files;
    }

    // ------------------------------------------------------------------
    // Zip robustness: java.util.zip never exposes the unix mode bits, so the
    // central directory is read directly to find symlink entries.
    // ------------------------------------------------------------------

    /** Returns {@code name -> unix mode} for entries whose archive stored one. */
    private static Map<String, Integer> unixEntryModes(byte[] zip) {
        Map<String, Integer> modes = new LinkedHashMap<>();
        int eocd = findEocd(zip);
        if (eocd < 0) {
            // A zip without an end-of-central-directory record is either empty or truncated; the
            // stream reader below turns it into INVALID_BUNDLE, so there is nothing to reject here.
            return modes;
        }
        int total = u16(zip, eocd + 10);
        long centralOffset = u32(zip, eocd + 16);
        if (centralOffset < 0 || centralOffset + 46 > zip.length) {
            return modes;
        }
        int cursor = (int) centralOffset;
        for (int index = 0; index < total; index++) {
            if (cursor + 46 > zip.length || i32(zip, cursor) != ZIP_CENTRAL_SIG) {
                return modes;
            }
            int mode = (int) ((u32(zip, cursor + 38) >>> 16) & 0xFFFFL);
            int nameLength = u16(zip, cursor + 28);
            int extraLength = u16(zip, cursor + 30);
            int commentLength = u16(zip, cursor + 32);
            if (cursor + 46 + nameLength > zip.length) {
                return modes;
            }
            String name = new String(zip, cursor + 46, nameLength, StandardCharsets.UTF_8);
            modes.put(name, mode);
            cursor += 46 + nameLength + extraLength + commentLength;
        }
        return modes;
    }

    private static int findEocd(byte[] zip) {
        int start = Math.max(0, zip.length - ZIP_EOCD_MIN - ZIP_EOCD_MAX_COMMENT);
        for (int index = zip.length - ZIP_EOCD_MIN; index >= start; index--) {
            if (i32(zip, index) == ZIP_EOCD_SIG) {
                return index;
            }
        }
        return -1;
    }

    private static int i32(byte[] data, int offset) {
        if (offset < 0 || offset + 4 > data.length) {
            return Integer.MIN_VALUE;
        }
        return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8)
                | ((data[offset + 2] & 0xFF) << 16) | ((data[offset + 3] & 0xFF) << 24);
    }

    private static long u32(byte[] data, int offset) {
        if (offset < 0 || offset + 4 > data.length) {
            return -1L;
        }
        return (data[offset] & 0xFFL) | ((data[offset + 1] & 0xFFL) << 8)
                | ((data[offset + 2] & 0xFFL) << 16) | ((data[offset + 3] & 0xFFL) << 24);
    }

    private static int u16(byte[] data, int offset) {
        if (offset < 0 || offset + 2 > data.length) {
            return -1;
        }
        return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    static String sha256Hex(byte[] data) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(data));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private static CpApiException invalid(String code, String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, code, detail);
    }
}
