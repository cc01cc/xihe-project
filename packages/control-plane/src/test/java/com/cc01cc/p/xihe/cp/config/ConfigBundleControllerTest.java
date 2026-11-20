package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-84 (DSD-1480): the zip bundle pair is additive next to the single-JSONC import/export pair.
 *
 * <p>Positive/negative pairing (DSD-1476): 正1 round trip + manifest/product equivalence, 正2 response
 * shape parity, 反1 tampered payload is a zero-write 400, 反2 missing manifest / unknown version,
 * 反3 traversal / absolute / symlink entries, 反5 provider connections stay skipped. 反4 (the existing
 * single-JSONC suite stays green) cannot run on H2 at all (see below), so the three single-JSONC
 * faces are mirrored here and run on the same lane as the bundle pair.
 *
 * <p>Why the PostgreSQL lane and not H2: every instance-scope action-atom gate goes through
 * RequesterAuthority#actionAtoms, which unions org-unit grants; that query is raw JDBC over
 * ltree ({@code chain.path @> own.path}) with no JPA entity and no H2 shim, so on H2 it throws
 * "Table org_unit_members not found" and the gate fails closed with 403 for every write. The
 * behaviour under test is the bundle transport, not the shim gap, so this class runs where the
 * org-unit query is actually expressible.
 */
class ConfigBundleControllerTest extends AbstractIntegrationTest {

    private static final String CONFIG_ENTRY = "config/instance.jsonc";
    private static final String MANIFEST_ENTRY = "manifest.json";

    // ------------------------------------------------------------------
    // 正1 + auth: export is admin-only, and the manifest describes the very bytes the
    // single-JSONC export produces (proves the payload is reused, not re-serialised).
    // ------------------------------------------------------------------

    @Test
    void exportBundle_isAdminOnly_andManifestMatchesTheJsoncExportProduct() throws IOException {
        String admin = adminToken();
        ResponseEntity<byte[]> bundle = restTemplate.exchange(
            url("/api/v1/config/bundle/export?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(admin)), byte[].class);

        assertEquals(HttpStatus.OK, bundle.getStatusCode());
        assertNotNull(bundle.getHeaders().getContentType());
        assertTrue(bundle.getHeaders().getContentType().toString().contains("application/zip"),
            "expected application/zip, got " + bundle.getHeaders().getContentType());
        assertEquals("no-store", bundle.getHeaders().getCacheControl());
        assertTrue(String.valueOf(bundle.getHeaders().getFirst("Content-Disposition"))
            .contains("xihe-config-bundle.zip"));

        Map<String, byte[]> entries = unzip(bundle.getBody());
        assertEquals(List.of(MANIFEST_ENTRY, CONFIG_ENTRY), new ArrayList<>(entries.keySet()));

        Map<String, Object> manifest = manifestOf(entries.get(MANIFEST_ENTRY));
        assertEquals(1, manifest.get("formatVersion"));
        assertEquals("instance", manifest.get("layer"));
        List<Map<String, Object>> files = filesOf(manifest);
        assertEquals(1, files.size());
        assertEquals(CONFIG_ENTRY, files.get(0).get("path"));

        byte[] payload = entries.get(CONFIG_ENTRY);
        assertEquals(sha256Hex(payload), files.get(0).get("sha256"));
        assertEquals(payload.length, ((Number) files.get(0).get("bytes")).longValue());

        // The payload must be the byte-for-byte product of the existing JSONC export face.
        ResponseEntity<byte[]> jsonc = restTemplate.exchange(
            url("/api/v1/config/export?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(admin)), byte[].class);
        assertEquals(HttpStatus.OK, jsonc.getStatusCode());
        assertEquals(new String(jsonc.getBody(), StandardCharsets.UTF_8),
            new String(payload, StandardCharsets.UTF_8),
            "bundle payload must be the untouched exportJsonc product");

        ResponseEntity<Map> forbidden = restTemplate.exchange(
            url("/api/v1/config/bundle/export?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, forbidden.getStatusCode());
    }

    // ------------------------------------------------------------------
    // 正1 round trip + 正2 shape parity
    // ------------------------------------------------------------------

    @Test
    void bundleRoundTrip_restoresConfigValues_andKeepsTheImportResponseShape() throws IOException {
        String admin = adminToken();
        putLogging(admin, "WARN");
        byte[] bundle = exportBundle(admin);

        putLogging(admin, "ERROR");
        assertEquals("ERROR", getLogging(admin));

        ResponseEntity<Map> resp = postBundle(bundle, admin);
        assertEquals(HttpStatus.OK, resp.getStatusCode());
        assertEquals("ok", resp.getBody().get("status"));
        assertTrue(resp.getBody().containsKey("imported"));
        assertTrue(resp.getBody().containsKey("skipped"));
        assertTrue(resp.getBody().containsKey("warnings"));
        assertTrue(((Number) resp.getBody().get("imported")).intValue() >= 1);
        assertEquals("WARN", getLogging(admin), "import must restore the exported value");
    }

    // ------------------------------------------------------------------
    // 反1: one tampered byte is a whole-bundle rejection with zero writes.
    // ------------------------------------------------------------------

    @Test
    void importBundle_rejectsTamperedPayload_andWritesNothing() throws IOException {
        String admin = adminToken();
        putLogging(admin, "WARN");
        Map<String, byte[]> exported = unzip(exportBundle(admin));

        putLogging(admin, "ERROR");
        String exportBeforeAttempt = plainExport(admin);

        Map<String, byte[]> tampered = new LinkedHashMap<>();
        tampered.put(MANIFEST_ENTRY, exported.get(MANIFEST_ENTRY));
        tampered.put(CONFIG_ENTRY, "{\"logging\":{\"logLevel\":\"DEBUG\"}}"
            .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> resp = postBundle(zipOf(tampered), admin);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("MANIFEST_MISMATCH", resp.getBody().get("code"));
        assertEquals("ERROR", getLogging(admin), "a rejected bundle must not change config");
        assertEquals(exportBeforeAttempt, plainExport(admin),
            "every instance-layer row must be byte-identical after the rejected import");
    }

    // ------------------------------------------------------------------
    // 反2: no manifest, or an unknown formatVersion, never degrades into guessing by name.
    // ------------------------------------------------------------------

    @Test
    void importBundle_rejectsMissingManifest_andUnknownFormatVersion() throws IOException {
        String admin = adminToken();

        Map<String, byte[]> payloadOnly = new LinkedHashMap<>();
        payloadOnly.put(CONFIG_ENTRY, "{\"logging\":{\"logLevel\":\"WARN\"}}"
            .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> noManifest = postBundle(zipOf(payloadOnly), admin);
        assertEquals(HttpStatus.BAD_REQUEST, noManifest.getStatusCode());
        assertEquals("MISSING_MANIFEST", noManifest.getBody().get("code"));

        Map<String, byte[]> version99 = new LinkedHashMap<>();
        version99.put(CONFIG_ENTRY, "{\"logging\":{\"logLevel\":\"WARN\"}}"
            .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> badVersion = postBundle(bundleOf(version99, 99), admin);
        assertEquals(HttpStatus.BAD_REQUEST, badVersion.getStatusCode());
        assertEquals("UNSUPPORTED_BUNDLE_VERSION", badVersion.getBody().get("code"));
    }

    // ------------------------------------------------------------------
    // 反3: traversal, absolute names and symlink entries are rejected, and nothing is written
    // outside the caller's directory (this server never extracts to disk at all).
    // ------------------------------------------------------------------

    @Test
    void importBundle_rejectsTraversalAbsoluteAndSymlinkEntries_withoutTouchingTheFilesystem()
            throws IOException {
        String admin = adminToken();
        Path sandbox = Files.createTempDirectory("xihe-bundle-sandbox-");
        Path sentinel = Files.createFile(sandbox.resolve("sentinel.txt"));
        Files.writeString(sentinel, "untouched");
        List<String> before = listTree(sandbox);

        // traversal: the entry name itself is rejected before any manifest logic runs
        Map<String, byte[]> traversal = new LinkedHashMap<>();
        traversal.put("../escape.txt", "pwned".getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> traversalResp = postBundle(zipOf(traversal), admin);
        assertEquals(HttpStatus.BAD_REQUEST, traversalResp.getStatusCode());
        assertEquals("INVALID_BUNDLE_ENTRY", traversalResp.getBody().get("code"));

        // absolute path, same refusal class
        Map<String, byte[]> absolute = new LinkedHashMap<>();
        absolute.put("/etc/passwd", "pwned".getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> absoluteResp = postBundle(zipOf(absolute), admin);
        assertEquals(HttpStatus.BAD_REQUEST, absoluteResp.getStatusCode());
        assertEquals("INVALID_BUNDLE_ENTRY", absoluteResp.getBody().get("code"));

        // symlink: a well-formed bundle whose payload entry carries the unix S_IFLNK mode
        Map<String, byte[]> payload = new LinkedHashMap<>();
        payload.put(CONFIG_ENTRY, "{\"logging\":{\"logLevel\":\"WARN\"}}"
            .getBytes(StandardCharsets.UTF_8));
        byte[] symlinked = withUnixMode(bundleOf(payload, 1), CONFIG_ENTRY, 0xA1FF);
        ResponseEntity<Map> symlinkResp = postBundle(symlinked, admin);
        assertEquals(HttpStatus.BAD_REQUEST, symlinkResp.getStatusCode());
        assertEquals("INVALID_BUNDLE_ENTRY", symlinkResp.getBody().get("code"));
        assertTrue(String.valueOf(symlinkResp.getBody().get("detail")).contains("symbolic link"));

        assertEquals(before, listTree(sandbox), "the sandbox directory must be unchanged");
        assertFalse(Files.exists(sandbox.resolve("escape.txt")));
        assertFalse(Files.exists(sandbox.getParent().resolve("escape.txt")));
    }

    // ------------------------------------------------------------------
    // 反5 (DSD-1482 unchanged): provider connections are never restored by a bundle either.
    // ------------------------------------------------------------------

    @Test
    void importBundle_skipsProviderConnections_andStillAppliesConfig() throws IOException {
        String admin = adminToken();
        String payload = "{\"logging\":{\"logLevel\":\"TRACE\"},"
            + "\"provider-connections\":[{\"providerId\":\"openai\",\"label\":\"bundle\"}]}";
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put(CONFIG_ENTRY, payload.getBytes(StandardCharsets.UTF_8));

        ResponseEntity<Map> resp = postBundle(bundleOf(files, 1), admin);
        assertEquals(HttpStatus.OK, resp.getStatusCode());
        assertEquals("ok", resp.getBody().get("status"));
        assertTrue(((Number) resp.getBody().get("skipped")).intValue() >= 1);
        assertTrue(String.valueOf(resp.getBody().get("warnings")).contains("never restore credentials"),
            "warnings must state that credentials are not restored: " + resp.getBody().get("warnings"));
        assertEquals("TRACE", getLogging(admin), "the config section must still be applied");
    }

    // ------------------------------------------------------------------
    // Trivial refusals: no file entry to verify (DSD-1476 negative pair).
    // ------------------------------------------------------------------

    @Test
    void importBundle_rejectsEmptyZipPayload() throws IOException {
        ResponseEntity<Map> resp = postBundle(zipOf(Map.of()), adminToken());
        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("INVALID_BUNDLE", resp.getBody().get("code"));
    }

    @Test
    void importBundle_rejectsDirectoryOnlyZipPayload() throws IOException {
        ResponseEntity<Map> resp = postBundle(directoryOnlyZip(), adminToken());
        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("INVALID_BUNDLE", resp.getBody().get("code"));
    }

    // ------------------------------------------------------------------
    // Single-JSONC faces, mirrored on the PostgreSQL lane. The existing
    // assertions live in ConfigControllerTest, whose base class pins
    // @ActiveProfiles("h2"); that lane answers every instance-scope atom gate
    // with 403 because the org-unit query is raw ltree SQL (see the H2 blocker
    // noted in the evidence README). These three cases keep the single-JSONC
    // contract covered on a schema that can actually evaluate it.
    // ------------------------------------------------------------------

    @Test
    void singleJsoncImport_instanceOnly_stillAcceptsAdminAndRejectsUser() {
        HttpHeaders adminHeaders = authHeaders(adminToken());
        adminHeaders.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> ok = restTemplate.exchange(
            url("/api/v1/config/import?layer=instance"), HttpMethod.POST,
            new HttpEntity<>("{\"logging\":{\"logLevel\":\"ERROR\"}}", adminHeaders), Map.class);
        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals("ok", ok.getBody().get("status"));
        assertNotNull(ok.getBody().get("warnings"));

        HttpHeaders userHeaders = authHeaders(userToken());
        userHeaders.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> forbidden = restTemplate.exchange(
            url("/api/v1/config/import?layer=instance"), HttpMethod.POST,
            new HttpEntity<>("{\"logging\":{\"logLevel\":\"ERROR\"}}", userHeaders), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, forbidden.getStatusCode());
    }

    @Test
    void singleJsoncExport_adminOnly_stillAcceptsAdminAndRejectsUser() {
        ResponseEntity<String> ok = restTemplate.exchange(
            url("/api/v1/config/export?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(adminToken())), String.class);
        assertEquals(HttpStatus.OK, ok.getStatusCode());

        ResponseEntity<Map> forbidden = restTemplate.exchange(
            url("/api/v1/config/export?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, forbidden.getStatusCode());
    }

    @Test
    void singleJsoncExport_includeSecretsBoundaryAndNoStoreHeader_stillHolds() {
        ResponseEntity<String> resp = restTemplate.exchange(
            url("/api/v1/config/export?layer=instance&includeSecrets=false"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(adminToken())), String.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        assertEquals("no-store", resp.getHeaders().getCacheControl());
        assertFalse(resp.getBody().contains("credential_ciphertext"));
        assertFalse(resp.getBody().contains("apiKey"));
    }

    // ------------------------------------------------------------------
    // Trivial refusals: not a zip at all.
    // ------------------------------------------------------------------

    @Test
    void importBundle_rejectsNonZipPayload() {
        ResponseEntity<Map> resp = postBundle("not-a-zip".getBytes(StandardCharsets.UTF_8), adminToken());
        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("INVALID_BUNDLE", resp.getBody().get("code"));
    }

    // ------------------------------------------------------------------
    // HTTP helpers
    // ------------------------------------------------------------------

    private String getLogging(String token) {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/logging"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(token)), Map.class);
        assertEquals(HttpStatus.OK, resp.getStatusCode());
        return String.valueOf(resp.getBody().get("logLevel"));
    }

    private void putLogging(String token, String level) {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/instance/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", level), authHeaders(token)), Map.class);
        assertEquals(HttpStatus.OK, resp.getStatusCode());
    }

    private byte[] exportBundle(String token) {
        ResponseEntity<byte[]> resp = restTemplate.exchange(
            url("/api/v1/config/bundle/export?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(token)), byte[].class);
        assertEquals(HttpStatus.OK, resp.getStatusCode());
        return resp.getBody();
    }

    private String plainExport(String token) {
        ResponseEntity<String> resp = restTemplate.exchange(
            url("/api/v1/config/export?layer=instance"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(token)), String.class);
        assertEquals(HttpStatus.OK, resp.getStatusCode());
        return resp.getBody();
    }

    private ResponseEntity<Map> postBundle(byte[] zipBytes, String token) {
        MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();
        form.add("file", new ByteArrayResource(zipBytes) {
            @Override
            public String getFilename() {
                return "bundle.zip";
            }
        });
        HttpHeaders headers = authHeaders(token);
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        return restTemplate.exchange(
            url("/api/v1/config/bundle/import"), HttpMethod.POST,
            new HttpEntity<>(form, headers), Map.class);
    }

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private String userToken() {
        String password = TestDataFactory.PASSWORD;
        ResponseEntity<Map> reg = restTemplate.postForEntity(
            url("/api/v1/auth/register"),
            Map.of("email", "bundle-user-" + System.nanoTime() + "@test.com",
                "password", password, "name", "BundleUser"),
            Map.class);
        assertEquals(HttpStatus.CREATED, reg.getStatusCode());
        String token = (String) reg.getBody().get("accessToken");
        assertNotNull(token);
        return token;
    }

    private String adminToken() {
        ResponseEntity<Map> login = restTemplate.postForEntity(
            url("/api/v1/auth/login"),
            Map.of("identifier", "admin@xihe.local", "password", DataSeeder.seededAdminPassword()),
            Map.class);
        assertEquals(HttpStatus.OK, login.getStatusCode());
        String token = (String) login.getBody().get("accessToken");
        assertNotNull(token);
        return token;
    }

    // ------------------------------------------------------------------
    // Archive helpers
    // ------------------------------------------------------------------

    private static byte[] zipOf(Map<String, byte[]> entries) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                ZipEntry node = new ZipEntry(entry.getKey());
                node.setTime(0L);
                zip.putNextEntry(node);
                zip.write(entry.getValue());
                zip.closeEntry();
            }
        }
        return out.toByteArray();
    }

    /** A readable zip that carries one directory entry and nothing else. */
    private static byte[] directoryOnlyZip() throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
            ZipEntry dir = new ZipEntry("config/");
            dir.setTime(0L);
            zip.putNextEntry(dir);
            zip.closeEntry();
        }
        return out.toByteArray();
    }

    /** {@code payloads} plus a manifest that describes exactly those files. */
    private static byte[] bundleOf(Map<String, byte[]> payloads, int formatVersion) throws IOException {
        Map<String, byte[]> all = new LinkedHashMap<>();
        all.put(MANIFEST_ENTRY, manifestJson(payloads, formatVersion));
        all.putAll(payloads);
        return zipOf(all);
    }

    private static byte[] manifestJson(Map<String, byte[]> files, int formatVersion) {
        StringBuilder json = new StringBuilder();
        json.append("{\"formatVersion\":").append(formatVersion)
            .append(",\"layer\":\"instance\",\"files\":[");
        boolean first = true;
        for (Map.Entry<String, byte[]> file : files.entrySet()) {
            if (!first) {
                json.append(',');
            }
            first = false;
            json.append("{\"path\":\"").append(file.getKey())
                .append("\",\"sha256\":\"").append(sha256Hex(file.getValue()))
                .append("\",\"bytes\":").append(file.getValue().length).append('}');
        }
        json.append("]}");
        return json.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static Map<String, byte[]> unzip(byte[] zipBytes) throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(zipBytes),
                StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (!entry.isDirectory()) {
                    entries.put(entry.getName(), zip.readAllBytes());
                }
            }
        }
        return entries;
    }

    /**
     * Rewrites the central-directory external attributes of one entry, the only place a zip stores
     * the unix mode. {@code java.util.zip} cannot produce such an entry, so the fixture is patched.
     */
    private static byte[] withUnixMode(byte[] zipBytes, String entryName, int mode) {
        byte[] copy = zipBytes.clone();
        int eocd = -1;
        for (int index = copy.length - 22; index >= Math.max(0, copy.length - 22 - 0xFFFF); index--) {
            if (le32(copy, index) == 0x06054b50) {
                eocd = index;
                break;
            }
        }
        assertTrue(eocd >= 0, "fixture zip must carry an end-of-central-directory record");
        int total = le16(copy, eocd + 10);
        int cursor = (int) le32u(copy, eocd + 16);
        for (int index = 0; index < total; index++) {
            int nameLength = le16(copy, cursor + 28);
            int extraLength = le16(copy, cursor + 30);
            int commentLength = le16(copy, cursor + 32);
            String name = new String(copy, cursor + 46, nameLength, StandardCharsets.UTF_8);
            if (entryName.equals(name)) {
                copy[cursor + 38] = 0;
                copy[cursor + 39] = 0;
                copy[cursor + 40] = (byte) (mode & 0xFF);
                copy[cursor + 41] = (byte) ((mode >> 8) & 0xFF);
                return copy;
            }
            cursor += 46 + nameLength + extraLength + commentLength;
        }
        throw new IllegalStateException("fixture entry not found: " + entryName);
    }

    private static int le32(byte[] data, int offset) {
        return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8)
            | ((data[offset + 2] & 0xFF) << 16) | ((data[offset + 3] & 0xFF) << 24);
    }

    private static long le32u(byte[] data, int offset) {
        return (data[offset] & 0xFFL) | ((data[offset + 1] & 0xFFL) << 8)
            | ((data[offset + 2] & 0xFFL) << 16) | ((data[offset + 3] & 0xFFL) << 24);
    }

    private static int le16(byte[] data, int offset) {
        return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8);
    }

    private static String sha256Hex(byte[] data) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static List<String> listTree(Path root) throws IOException {
        List<String> paths = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(root)) {
            walk.forEach(path -> paths.add(root.relativize(path).toString()));
        }
        paths.sort(String::compareTo);
        return paths;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> manifestOf(byte[] manifestBytes) throws IOException {
        return new com.fasterxml.jackson.databind.ObjectMapper()
            .readValue(manifestBytes, Map.class);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> filesOf(Map<String, Object> manifest) {
        return (List<Map<String, Object>>) manifest.get("files");
    }
}
