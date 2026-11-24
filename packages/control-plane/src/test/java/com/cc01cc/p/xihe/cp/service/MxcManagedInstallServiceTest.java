package com.cc01cc.p.xihe.cp.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * task-992 installer contract: checksum-gated, x64-only, atomic, no partial installs.
 */
class MxcManagedInstallServiceTest {

    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    @Test
    void installs_a_verified_archive_and_reports_managed(@TempDir Path temp) throws IOException {
        byte[] archive = archiveWithExecutable();
        String url = serve(archive, 200);
        String sha = sha256(archive);
        MxcManagedInstallService service = new MxcManagedInstallService(
                temp.resolve("mxc"), url, archive.length, sha, true);

        Map<String, Object> snapshot = service.install();

        assertEquals(WorkspaceBackendPolicy.MXC_INSTALL_MANAGED, snapshot.get("state"));
        assertEquals("managed", snapshot.get("source"));
        assertEquals("verified", snapshot.get("checksumState"));
        assertEquals(MxcManagedInstallService.MXC_MANAGED_VERSION, snapshot.get("managedVersion"));
        assertTrue(Files.isRegularFile(installDir(temp).resolve("install.json")));
        assertTrue(Files.isRegularFile(
                installDir(temp).resolve(MxcManagedInstallService.MXC_MANAGED_VERSION).resolve("x64").resolve("wxc-exec.exe")));
        // Only x64/** is extracted.
        assertFalse(Files.exists(
                installDir(temp).resolve(MxcManagedInstallService.MXC_MANAGED_VERSION).resolve("docs")));
        // Staging is removed on success.
        assertFalse(Files.exists(installDir(temp).resolve(".staging")));
        // The manifest carries the pinned sha256 so the Runtime can re-verify.
        String manifest = Files.readString(installDir(temp).resolve("install.json"));
        assertTrue(manifest.contains(sha));
    }

    @Test
    void checksum_mismatch_refuses_the_install_and_leaves_nothing_behind(@TempDir Path temp) throws IOException {
        byte[] archive = archiveWithExecutable();
        String url = serve(archive, 200);
        MxcManagedInstallService service = new MxcManagedInstallService(
                temp.resolve("mxc"), url, archive.length, "deadbeef", true);

        CpApiException error = assertThrows(CpApiException.class, service::install);

        assertEquals(MxcManagedInstallService.MXC_CHECKSUM_MISMATCH, error.getCode());
        assertFalse(Files.exists(installDir(temp).resolve("install.json")));
        assertFalse(Files.exists(
                installDir(temp).resolve(MxcManagedInstallService.MXC_MANAGED_VERSION).resolve("x64")));
        assertFalse(Files.exists(installDir(temp).resolve(".staging")), "staging must be cleaned");
        assertEquals(WorkspaceBackendPolicy.MXC_INSTALL_MISSING, service.snapshot().get("state"));
    }

    @Test
    void archive_without_x64_executable_is_rejected(@TempDir Path temp) throws IOException {
        byte[] archive = archiveWithoutExecutable();
        String url = serve(archive, 200);
        MxcManagedInstallService service = new MxcManagedInstallService(
                temp.resolve("mxc"), url, archive.length, sha256(archive), true);

        CpApiException error = assertThrows(CpApiException.class, service::install);

        assertEquals(MxcManagedInstallService.MXC_ARCHIVE_INVALID, error.getCode());
        assertFalse(Files.exists(installDir(temp).resolve("install.json")));
        assertFalse(Files.exists(installDir(temp).resolve(".staging")));
    }

    @Test
    void blank_source_reports_not_configured_instead_of_a_fake_button(@TempDir Path temp) {
        MxcManagedInstallService service =
                new MxcManagedInstallService(temp.resolve("mxc"), "", 1, "x", true);

        Map<String, Object> snapshot = service.snapshot();
        assertEquals(false, snapshot.get("installSupported"));
        assertEquals(false, snapshot.get("sourceConfigured"));
        CpApiException error = assertThrows(CpApiException.class, service::install);
        assertEquals(MxcManagedInstallService.MXC_SOURCE_NOT_CONFIGURED, error.getCode());
    }

    @Test
    void instance_override_is_written_to_override_json_and_can_be_cleared(@TempDir Path temp) throws IOException {
        Path exe = temp.resolve("custom-wxc-exec.exe");
        Files.writeString(exe, "custom");
        MxcManagedInstallService service =
                new MxcManagedInstallService(temp.resolve("mxc"), "", 1, "x", true);

        Map<String, Object> snapshot = service.setOverride(exe.toString());

        assertEquals("instance(override)", snapshot.get("source"));
        assertEquals(true, snapshot.get("overridePresent"));
        assertTrue(Files.isRegularFile(installDir(temp).resolve("override.json")));

        Map<String, Object> cleared = service.clearOverride();
        assertEquals(false, cleared.get("overridePresent"));
        assertFalse(Files.exists(installDir(temp).resolve("override.json")));
    }

    @Test
    void relative_override_path_is_refused(@TempDir Path temp) {
        MxcManagedInstallService service =
                new MxcManagedInstallService(temp.resolve("mxc"), "", 1, "x", true);
        CpApiException error =
                assertThrows(CpApiException.class, () -> service.setOverride("relative/wxc-exec.exe"));
        assertEquals("INVALID_REQUEST", error.getCode());
    }

    @Test
    void pruning_keeps_two_versions_and_moves_the_rest_to_stale(@TempDir Path temp) throws IOException {
        Path installDir = installDir(temp);
        for (String version : new String[] {"0.9.0", "1.0.0"}) {
            Path dir = installDir.resolve(version).resolve("x64");
            Files.createDirectories(dir);
            Files.writeString(dir.resolve("wxc-exec.exe"), version);
        }
        byte[] archive = archiveWithExecutable();
        String url = serve(archive, 200);
        MxcManagedInstallService service = new MxcManagedInstallService(
                installDir, url, archive.length, sha256(archive), true);

        service.install();

        assertTrue(Files.isDirectory(installDir.resolve(MxcManagedInstallService.MXC_MANAGED_VERSION).resolve("x64")));
        assertTrue(Files.isDirectory(installDir.resolve("1.0.0").resolve("x64")));
        assertFalse(Files.isDirectory(installDir.resolve("0.9.0").resolve("x64")), "oldest version must leave the active set");
        assertNotNull(service.snapshot().get("availableVersions"));
    }

    private Path installDir(Path temp) {
        return temp.resolve("mxc");
    }

    private String serve(byte[] body, int status) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/mxc.zip", exchange -> {
            exchange.getResponseHeaders().add("Content-Type", "application/zip");
            exchange.sendResponseHeaders(status, body.length);
            try (OutputStream output = exchange.getResponseBody()) {
                output.write(body);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/mxc.zip";
    }

    private static byte[] archiveWithExecutable() throws IOException {
        return archive("x64/wxc-exec.exe", "x64/symbols/wxc-exec.pdb", "docs/readme.md", "x64/config/default.json");
    }

    private static byte[] archiveWithoutExecutable() throws IOException {
        return archive("docs/readme.md");
    }

    private static byte[] archive(String... entries) throws IOException {
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes, StandardCharsets.UTF_8)) {
            for (String name : entries) {
                zip.putNextEntry(new ZipEntry(name));
                zip.write(("payload of " + name).getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
        }
        return bytes.toByteArray();
    }

    private static String sha256(byte[] body) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            return java.util.HexFormat.of().formatHex(digest.digest(body));
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }
}
