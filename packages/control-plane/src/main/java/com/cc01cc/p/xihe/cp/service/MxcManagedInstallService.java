package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * task-992: product-managed MXC installation (R51/R52 installer body).
 *
 * <p>MXC ships as a green zip — no installer, no registry, no service. Xihe therefore
 * owns a directory in the user profile, pins the version and the archive hash, and
 * never touches the system PATH. The Runtime resolves the very same directory (see
 * {@code runtime/src/mxc_install.rs}), so "installed under our directory" and
 * "actually used by the executor" cannot drift.
 *
 * <p>Security boundary note (must stay in the evidence, not just the code): MXC's own
 * documentation describes it as an early preview that is <b>not</b> a security boundary.
 * Xihe treats it as defense-in-depth only and never promises isolation guarantees.
 */
@Service
public class MxcManagedInstallService {

    private static final Logger log = LoggerFactory.getLogger(MxcManagedInstallService.class);

    /** Pinned official release (Lead verified 2026-11-24). */
    public static final String MXC_MANAGED_VERSION = "1.1.0";
    public static final String MXC_ARCHIVE_NAME = "mxc-release-binaries.zip";
    public static final long MXC_ARCHIVE_SIZE_BYTES = 533_829_612L;
    public static final String MXC_ARCHIVE_SHA256 =
            "31a44963e288e3af23bc2e7e350608ed28f7c76b922ee7a7f1758a486dda37b3";
    public static final String MXC_DEFAULT_SOURCE_URL =
            "https://github.com/microsoft/mxc/releases/download/v1.1.0/mxc-release-binaries.zip";

    public static final String SOURCE_URL_ENV = "XIHE_MXC_SOURCE_URL";
    public static final String ALLOW_INSECURE_SOURCE_ENV = "XIHE_MXC_ALLOW_INSECURE_SOURCE";

    public static final String MXC_INSTALL_BUSY = "MXC_INSTALL_BUSY";
    public static final String MXC_SOURCE_NOT_CONFIGURED = "MXC_SOURCE_NOT_CONFIGURED";
    public static final String MXC_CHECKSUM_MISMATCH = "MXC_CHECKSUM_MISMATCH";
    public static final String MXC_NOT_INSTALLED = "MXC_NOT_INSTALLED";
    public static final String MXC_MANIFEST_INVALID = "MXC_MANIFEST_INVALID";
    public static final String MXC_DOWNLOAD_FAILED = "MXC_DOWNLOAD_FAILED";
    public static final String MXC_ARCHIVE_INVALID = "MXC_ARCHIVE_INVALID";
    public static final String MXC_INSTANCE_OVERRIDE_MISSING = "MXC_INSTANCE_OVERRIDE_MISSING";

    public static final String INSTALL_MANIFEST = "install.json";
    public static final String INSTANCE_OVERRIDE = "override.json";
    public static final String WXC_EXEC_NAME = "wxc-exec.exe";
    private static final String EXECUTABLE_RELATIVE = "x64/" + WXC_EXEC_NAME;
    private static final String STAGING_DIR = ".staging";
    private static final String STALE_DIR = ".stale";
    private static final long MAX_ARCHIVE_BYTES = 700L * 1024 * 1024;
    private static final int MAX_RETAINED_VERSIONS = 2;

    private final Path installDir;
    private final String sourceUrl;
    private final long expectedSize;
    private final String expectedSha256;
    private final boolean allowInsecureSource;
    private final boolean pathProbeEnabled;
    private final ReentrantLock installLock = new ReentrantLock();

    /**
     * task-997: the class has three constructors (this Spring one plus two package-private
     * test seams), so Spring cannot guess the injection point. Without this annotation it
     * falls back to a default constructor that does not exist and every full-context test
     * fails at startup with {@code NoSuchMethodException: ...<init>()}.
     */
    @Autowired
    public MxcManagedInstallService(
            @Value("${" + WorkspaceBackendPolicy.MXC_INSTALL_DIR_KEY + ":}") String installDirRaw,
            @Value("${" + SOURCE_URL_ENV + ":}") String sourceUrlRaw) {
        this(
                resolveInstallDir(installDirRaw),
                resolveSourceUrl(sourceUrlRaw),
                MXC_ARCHIVE_SIZE_BYTES,
                MXC_ARCHIVE_SHA256,
                isInsecureSourceAllowed(System.getenv(ALLOW_INSECURE_SOURCE_ENV)),
                true);
    }

    MxcManagedInstallService(
            Path installDir,
            String sourceUrl,
            long expectedSize,
            String expectedSha256,
            boolean allowInsecureSource) {
        // Test-facing constructor: PATH probing off by default so the host's own MXC
        // installation cannot change the asserted state.
        this(installDir, sourceUrl, expectedSize, expectedSha256, allowInsecureSource, false);
    }

    /** `pathProbeEnabled` exists so tests do not depend on the host's own MXC install. */
    MxcManagedInstallService(
            Path installDir,
            String sourceUrl,
            long expectedSize,
            String expectedSha256,
            boolean allowInsecureSource,
            boolean pathProbeEnabled) {
        this.installDir = installDir;
        this.sourceUrl = sourceUrl;
        this.expectedSize = expectedSize;
        this.expectedSha256 = expectedSha256;
        this.allowInsecureSource = allowInsecureSource;
        this.pathProbeEnabled = pathProbeEnabled;
    }

    /** Shared with {@link WorkspaceBackendPolicy}; the Runtime mirrors the same default. */
    public static Path resolveInstallDir(String raw) {
        if (raw != null && !raw.isBlank()) {
            return Path.of(raw.trim());
        }
        String localAppData = System.getenv("LOCALAPPDATA");
        String base = localAppData == null || localAppData.isBlank() ? "." : localAppData;
        return Path.of(base, "Xihe", "mxc");
    }

    static String resolveSourceUrl(String raw) {
        // An explicitly blank override means "this instance has no configured source":
        // the UI must say so instead of rendering a button that cannot work.
        if (raw != null) {
            return raw.trim();
        }
        return MXC_DEFAULT_SOURCE_URL;
    }

    static boolean isInsecureSourceAllowed(String raw) {
        return "1".equals(raw == null ? "" : raw.trim()) || "true".equalsIgnoreCase(raw == null ? "" : raw.trim());
    }

    public Path installDir() {
        return installDir;
    }

    /** Selector-facing snapshot: state + version + size + which source actually answers. */
    public Map<String, Object> snapshot() {
        Path overrideFile = installDir.resolve(INSTANCE_OVERRIDE);
        Path manifestFile = installDir.resolve(INSTALL_MANIFEST);

        String overrideExecutable = null;
        boolean overridePresent = Files.isRegularFile(overrideFile);
        if (overridePresent) {
            try {
                Map<String, Object> body = readJson(overrideFile);
                overrideExecutable = String.valueOf(body.getOrDefault("executable", "")).trim();
            } catch (RuntimeException error) {
                overrideExecutable = null;
            }
        }

        String envExecutable = System.getenv("XIHE_MXC_EXECUTABLE");
        boolean envOverride = envExecutable != null
                && !envExecutable.isBlank()
                && Files.isRegularFile(Path.of(envExecutable.trim()));

        String managedVersion = null;
        String checksumState = "unknown";
        boolean managed = false;
        if (Files.isRegularFile(manifestFile)) {
            try {
                Map<String, Object> body = readJson(manifestFile);
                managedVersion = String.valueOf(body.getOrDefault("version", ""));
                String declared = String.valueOf(body.getOrDefault("sha256", "")).toLowerCase();
                String relative = String.valueOf(body.getOrDefault("executable", EXECUTABLE_RELATIVE));
                Path exe = installDir.resolve(relative);
                if (Files.isRegularFile(exe)) {
                    String actual = sha256(exe);
                    if (actual.equalsIgnoreCase(declared)) {
                        managed = true;
                        checksumState = "verified";
                    } else {
                        checksumState = "mismatch";
                    }
                } else {
                    checksumState = "missing-executable";
                }
            } catch (IOException | RuntimeException error) {
                checksumState = "invalid-manifest";
            }
        }

        boolean system = !managed && pathProbeEnabled && hasPathExecutable();
        String state;
        String reason = null;
        if (managed) {
            state = WorkspaceBackendPolicy.MXC_INSTALL_MANAGED;
        } else if (system) {
            state = WorkspaceBackendPolicy.MXC_INSTALL_SYSTEM;
        } else {
            state = WorkspaceBackendPolicy.MXC_INSTALL_MISSING;
            reason = MXC_NOT_INSTALLED;
        }
        if ("mismatch".equals(checksumState) || "invalid-manifest".equals(checksumState)) {
            reason = MXC_CHECKSUM_MISMATCH;
        }

        String answering;
        if (envOverride) {
            answering = "env(override)";
        } else if (overrideExecutable != null && !overrideExecutable.isBlank()) {
            answering = Files.isRegularFile(Path.of(overrideExecutable))
                    ? "instance(override)"
                    : MXC_INSTANCE_OVERRIDE_MISSING;
        } else if (managed) {
            answering = "managed";
        } else if (system) {
            answering = "path";
        } else {
            answering = "none";
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("state", state);
        body.put("source", answering);
        body.put("installDir", installDir.toString());
        body.put("pinnedVersion", MXC_MANAGED_VERSION);
        body.put("downloadSizeBytes", expectedSize);
        body.put("sha256", expectedSha256);
        body.put("archiveName", MXC_ARCHIVE_NAME);
        body.put("sourceUrl", sourceUrl);
        body.put("sourceConfigured", !sourceUrl.isBlank());
        body.put("installSupported", !sourceUrl.isBlank());
        body.put("checksumState", checksumState);
        body.put("managedVersion", managedVersion);
        body.put("overridePresent", overridePresent);
        body.put("overrideExecutable", overrideExecutable);
        body.put("availableVersions", listVersions());
        body.put("systemInstallIsNotVersionControlled", WorkspaceBackendPolicy.MXC_INSTALL_SYSTEM.equals(state));
        if (reason != null) {
            body.put("reason", reason);
            body.put("detail", detailFor(reason));
        }
        body.put("hostResourceErrorCode", WorkspaceBackendPolicy.MXC_HOST_RESOURCE_EXHAUSTED);
        body.put("hostResourceDetail", WorkspaceBackendPolicy.MXC_HOST_RESOURCE_DETAIL);
        body.put("maturity", "experimental");
        body.put(
                "isolationDisclaimer",
                "MXC is an early preview and is not a security boundary; Xihe uses it as defense-in-depth only.");
        body.put("checkedAt", Instant.now().toString());
        return body;
    }

    /** Download → sha256 → extract x64/** → atomic rename → manifest. No partial install survives. */
    public Map<String, Object> install() {
        if (sourceUrl.isBlank()) {
            throw new CpApiException(HttpStatus.CONFLICT, MXC_SOURCE_NOT_CONFIGURED,
                    "No MXC download source is configured for this instance.");
        }
        if (!installLock.tryLock()) {
            throw new CpApiException(HttpStatus.CONFLICT, MXC_INSTALL_BUSY,
                    "Another MXC installation is already running.");
        }
        Path stagingRoot = installDir.resolve(STAGING_DIR);
        Path staging = stagingRoot.resolve("install-" + Instant.now().toEpochMilli());
        try {
            Files.createDirectories(staging);
            Path archive = download(staging.resolve(MXC_ARCHIVE_NAME));
            String actual = sha256(archive);
            if (!actual.equalsIgnoreCase(expectedSha256)) {
                throw new CpApiException(HttpStatus.CONFLICT, MXC_CHECKSUM_MISMATCH,
                        "MXC archive checksum mismatch (expected " + expectedSha256 + ", got " + actual
                                + "). Nothing was installed and the previous build was left untouched.");
            }
            Path extracted = extractX64(archive, staging.resolve("x64"));
            installVersion(extracted);
            pruneOldVersions();
            log.info("MXC {} installed under {}", MXC_MANAGED_VERSION, installDir);
            return snapshot();
        } catch (CpApiException error) {
            throw error;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new CpApiException(HttpStatus.BAD_GATEWAY, MXC_DOWNLOAD_FAILED,
                    "MXC download was interrupted");
        } catch (IOException error) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, MXC_DOWNLOAD_FAILED,
                    "MXC installation failed: " + error.getMessage());
        } finally {
            deleteQuietly(staging);
            cleanupEmpty(stagingRoot);
            installLock.unlock();
        }
    }

    /** Instance-owner override: an absolute path to an already installed executable. */
    public Map<String, Object> setOverride(String executablePath) {
        String trimmed = executablePath == null ? "" : executablePath.trim();
        if (trimmed.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "executablePath is required");
        }
        Path path = Path.of(trimmed);
        if (!path.isAbsolute()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "executablePath must be absolute");
        }
        if (!Files.isRegularFile(path)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, MXC_INSTANCE_OVERRIDE_MISSING,
                    "executablePath does not point at a file: " + path);
        }
        try {
            Files.createDirectories(installDir);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("executable", path.toString());
            body.put("setAt", Instant.now().toString());
            Files.writeString(installDir.resolve(INSTANCE_OVERRIDE),
                    com.fasterxml.jackson.databind.json.JsonMapper.builder().build()
                            .writeValueAsString(body),
                    StandardCharsets.UTF_8);
            return snapshot();
        } catch (IOException error) {
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "MXC_OVERRIDE_WRITE_FAILED",
                    error.getMessage());
        }
    }

    public Map<String, Object> clearOverride() {
        try {
            Files.deleteIfExists(installDir.resolve(INSTANCE_OVERRIDE));
        } catch (IOException error) {
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "MXC_OVERRIDE_WRITE_FAILED",
                    error.getMessage());
        }
        return snapshot();
    }

    private Path download(Path target) throws IOException, InterruptedException {
        URI uri = URI.create(sourceUrl);
        if (!"https".equalsIgnoreCase(uri.getScheme()) && !allowInsecureSource) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, MXC_SOURCE_NOT_CONFIGURED,
                    "MXC source must be https (set " + ALLOW_INSECURE_SOURCE_ENV
                            + "=1 only for tests/mirrors)");
        }
        HttpClient client = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NORMAL)
                .connectTimeout(Duration.ofSeconds(30))
                .build();
        HttpRequest request = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofMinutes(20))
                .GET()
                .build();
        HttpResponse<InputStream> response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() != 200) {
            throw new IOException("MXC download returned HTTP " + response.statusCode());
        }
        long written = 0;
        try (InputStream input = response.body(); OutputStream output = Files.newOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                written += read;
                if (written > MAX_ARCHIVE_BYTES) {
                    throw new IOException("MXC archive exceeded the " + MAX_ARCHIVE_BYTES + " byte guard");
                }
                output.write(buffer, 0, read);
            }
        }
        if (written != expectedSize) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, MXC_DOWNLOAD_FAILED,
                    "MXC archive size mismatch (expected " + expectedSize + " bytes, got " + written + ")");
        }
        return target;
    }

    private Path extractX64(Path archive, Path destination) throws IOException {
        Files.createDirectories(destination);
        try (ZipFile zip = new ZipFile(archive.toFile())) {
            var entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                String name = entry.getName().replace('\\', '/');
                if (!name.startsWith("x64/") || entry.isDirectory()) {
                    continue;
                }
                String relative = name.substring("x64/".length());
                if (relative.isBlank() || relative.contains("..")) {
                    continue;
                }
                Path target = destination.resolve(relative);
                Files.createDirectories(target.getParent());
                try (InputStream input = zip.getInputStream(entry);
                        OutputStream output = Files.newOutputStream(target)) {
                    input.transferTo(output);
                }
            }
        }
        if (!Files.isRegularFile(destination.resolve(WXC_EXEC_NAME))) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, MXC_ARCHIVE_INVALID,
                    "MXC archive did not contain x64/" + WXC_EXEC_NAME);
        }
        return destination;
    }

    private void installVersion(Path extractedX64) throws IOException {
        Path versionDir = installDir.resolve(MXC_MANAGED_VERSION);
        Path targetX64 = versionDir.resolve("x64");
        if (Files.exists(targetX64)) {
            // Same-version reinstall: renames the previous build into .stale so a
            // failed rename cannot destroy a working install.
            moveToStale(versionDir, MXC_MANAGED_VERSION);
        }
        Files.createDirectories(versionDir);
        Files.move(extractedX64, targetX64, StandardCopyOption.ATOMIC_MOVE);

        // The manifest hash is over the *executable* (what the Runtime re-verifies at
        // launch); the archive hash is kept separately for provenance.
        String executableSha256 = sha256(targetX64.resolve(WXC_EXEC_NAME));
        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("version", MXC_MANAGED_VERSION);
        manifest.put("executable", MXC_MANAGED_VERSION + "/" + EXECUTABLE_RELATIVE);
        manifest.put("sha256", executableSha256);
        manifest.put("archiveSha256", expectedSha256);
        manifest.put("sourceUrl", sourceUrl);
        manifest.put("installedAt", Instant.now().toString());
        Files.writeString(versionDir.resolve(INSTALL_MANIFEST), toJson(manifest), StandardCharsets.UTF_8);
        Files.writeString(installDir.resolve(INSTALL_MANIFEST), toJson(manifest), StandardCharsets.UTF_8);
    }

    private void pruneOldVersions() throws IOException {
        List<Path> versions = listVersionDirs();
        versions.sort(Comparator.comparing(Path::getFileName).reversed());
        for (int index = MAX_RETAINED_VERSIONS; index < versions.size(); index++) {
            moveToStale(versions.get(index), versions.get(index).getFileName().toString());
        }
    }

    private void moveToStale(Path versionDir, String name) throws IOException {
        Path stale = installDir.resolve(STALE_DIR);
        Files.createDirectories(stale);
        Path target = stale.resolve(name + "-" + Instant.now().toEpochMilli());
        Files.move(versionDir, target, StandardCopyOption.ATOMIC_MOVE);
    }

    private List<String> listVersions() {
        List<String> names = new ArrayList<>();
        for (Path dir : listVersionDirs()) {
            names.add(dir.getFileName().toString());
        }
        names.sort(Comparator.naturalOrder());
        return names;
    }

    private List<Path> listVersionDirs() {
        List<Path> dirs = new ArrayList<>();
        if (!Files.isDirectory(installDir)) {
            return dirs;
        }
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(installDir, Files::isDirectory)) {
            for (Path dir : stream) {
                String name = dir.getFileName().toString();
                if (!name.startsWith(".") && Files.isRegularFile(dir.resolve("x64").resolve(WXC_EXEC_NAME))) {
                    dirs.add(dir);
                }
            }
        } catch (IOException error) {
            log.warn("Listing MXC versions under {} failed: {}", installDir, error.getMessage());
        }
        return dirs;
    }

    private boolean hasPathExecutable() {
        String pathValue = System.getenv("PATH");
        if (pathValue == null) {
            return false;
        }
        for (String entry : pathValue.split(java.io.File.pathSeparator)) {
            if (!entry.isBlank() && Files.isRegularFile(Path.of(entry).resolve(WXC_EXEC_NAME))) {
                return true;
            }
        }
        return false;
    }

    static String sha256(Path path) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
        try (InputStream input = Files.newInputStream(path)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                digest.update(buffer, 0, read);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static Map<String, Object> readJson(Path path) {
        try {
            return com.fasterxml.jackson.databind.json.JsonMapper.builder().build()
                    .readValue(Files.readString(path, StandardCharsets.UTF_8), Map.class);
        } catch (IOException error) {
            throw new IllegalStateException(error.getMessage(), error);
        }
    }

    private static String toJson(Map<String, Object> body) {
        try {
            return com.fasterxml.jackson.databind.json.JsonMapper.builder().build().writeValueAsString(body);
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new IllegalStateException(error);
        }
    }

    private static String detailFor(String reason) {
        return switch (reason) {
            case MXC_NOT_INSTALLED -> "MXC is not installed. Use the one-click managed installer: it writes only "
                    + "under the Xihe-owned directory (" + resolveInstallDir(null) + ").";
            case MXC_CHECKSUM_MISMATCH -> "The managed MXC executable does not match its pinned sha256. "
                    + "Reinstall from the pinned release; PATH fallback is intentionally refused.";
            default -> reason;
        };
    }

    private static void deleteQuietly(Path path) {
        if (path == null || !Files.exists(path)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(path)) {
            walk.sorted(Comparator.reverseOrder()).forEach(entry -> {
                try {
                    Files.deleteIfExists(entry);
                } catch (IOException error) {
                    log.warn("Cleaning MXC staging {} failed: {}", entry, error.getMessage());
                }
            });
        } catch (IOException error) {
            log.warn("Cleaning MXC staging root {} failed: {}", path, error.getMessage());
        }
    }

    private static void cleanupEmpty(Path dir) {
        try {
            if (Files.isDirectory(dir) && isEmpty(dir)) {
                Files.deleteIfExists(dir);
            }
        } catch (IOException ignored) {
            // leaving an empty staging dir is harmless
        }
    }

    private static boolean isEmpty(Path dir) throws IOException {
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
            return !stream.iterator().hasNext();
        }
    }
}
