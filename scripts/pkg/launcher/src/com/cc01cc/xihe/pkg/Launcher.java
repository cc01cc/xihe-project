package com.cc01cc.xihe.pkg;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.UserPrincipal;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * PLAN-0632 M2-3: the packaged launcher.
 *
 * <p>Why Java and not Node: the installer must work on a clean Windows machine with no Node,
 * Python, Java or Docker installed. The package already ships a jlink Java runtime for the
 * control plane (D32-02 measurement), so the launcher reuses that runtime instead of adding a
 * second ~80 MB runtime just to execute a few hundred lines of supervision logic.
 *
 * <p>What it does (the same five-phase contract as {@code scripts/lib/service-supervisor.mjs},
 * PLAN-0632 M2-1 — this is a port, not a second design):
 *
 * <pre>
 *   pg    -> TCP accept on the bundled PostgreSQL (no psql/pg_isready exists in the zonky
 *            payload, D32-15, and `postgres --single` exits 0 even on SQL errors, D32-13)
 *   cp    -> GET /actuator/health == 200 (runs Flyway, so it is the real database gate)
 *   agent -> GET /internal/v1/agent/health == 200 (must come after CP: its startup config sync
 *            fails closed on `llm-provider`, measured 58.46 s of retry ladder without a CP)
 *   runtime -> GET /health == 200
 *   ui    -> GET / on the CP port == 200 (D32-06: the CP serves the SPA same-origin)
 * </pre>
 *
 * <p>Deliberate non-goals in this slice (documented in {@code installer-scope.md}): auto-update,
 * start-at-login / tray residency, code signing, silent enterprise install, automatic port
 * renegotiation, crash supervision after the launcher exits. The launcher starts the stack,
 * opens the browser and exits; {@code --stop} tears the process tree down again (D32-08).
 *
 * <p>Every wait is a bounded poll (explicit deadline + poll interval) and every probe is
 * appended to {@code <install>/logs/launcher.log}. No fixed sleeps as a wait mechanism.
 */
public final class Launcher {

    /** Ordered phases, mirrored from the Node supervisor's PHASE_ORDER. */
    private static final List<String> PHASE_ORDER = List.of("pg", "cp", "agent", "runtime", "ui");

    /**
     * Readiness budgets. Numbers and their evidence are copied from
     * {@code scripts/lib/service-supervisor.mjs} so the two implementations cannot drift silently.
     */
    private static final long PG_TIMEOUT_MS = 45_000;
    private static final long CP_TIMEOUT_MS = 240_000;
    private static final long AGENT_TIMEOUT_MS = 90_000;
    private static final long RUNTIME_TIMEOUT_MS = 60_000;
    private static final long UI_TIMEOUT_MS = 60_000;
    private static final long POLL_MS = 500;

    private static final Map<String, String> PHASE_HINTS = Map.of(
            "pg", "PostgreSQL 未监听：确认 payload/pgsql 已解压、data/pg 已初始化，并查看 logs/pg.err.log；"
                    + "注意不要用 `postgres --single` 判断（SQL 错误也 exit 0）。",
            "cp", "CP 未通过 /actuator/health：最常见是 PG 未就绪或 Flyway 失败（看 logs/cp.err.log 的迁移报错）；"
                    + "也检查 payload/cp 与 payload/jre 是否完整。",
            "agent", "Agent 未通过 /internal/v1/agent/health：本 launcher 已先等 CP 200，若仍失败看 logs/agent.err.log；"
                    + "日志出现 `Invalid port ':1]'` 说明 NO_PROXY 含 [::1]（launcher 已清洗，说明有别的层注入）。",
            "runtime", "Runtime 未通过 /health：查看 logs/runtime.err.log；确认 data/runtime-state 可写。",
            "ui", "CP 未返回 `/`：静态伺服（D32-06）可能未启用或 payload/ui 缺 index.html；"
                    + "检查 logs/cp.out.log 是否有 `ui static serving` 的 WARN。");

    private static final String ENV_FILE = "launcher.properties";
    private static final String PID_FILE = "launcher-pids.json";

    /* ------------------------------------------------- PLAN-0650 A: the security gate */

    /**
     * PLAN-0650 A-1: the two signatures the CP security validator emits
     * ({@code SecurityDefaultsValidator}). They are a cross-module contract — the CP owns the
     * texts, this launcher only consumes them — so {@code scripts/pkg/launcher-security.test.mjs}
     * pins both literals: an upstream rewrite must fail that test rather than silently disarm
     * the gate.
     *
     * <ul>
     *   <li>{@code Insecure default configuration detected} — the CP booted with
     *       {@code XIHE_ENV != prod} and is therefore <b>accepting factory defaults</b>. It still
     *       reaches health 200, which is exactly why "wait for the child to exit" proves nothing
     *       (BL-204 ①).</li>
     *   <li>{@code Refusing to start} — the CP was in prod and refused. The launcher must report
     *       that cause instead of a generic "process exited".</li>
     * </ul>
     *
     * <p>BL-204 A① (2026-11-04): the two literals are listed once, verbatim and with their CP
     * source, in {@link #SECURITY_LOG_SIGNATURES}. That table — not a keyword search and not a
     * regex — is what {@code scanLogFile} iterates, so "which CP lines fail the launcher" is an
     * enumerated answer with a file:line per entry instead of a fuzzy match. Anything severity-wise
     * outside this list (e.g. the other {@code Refusing to start: <config error>} validators) is
     * deliberately NOT matched: those make the child exit and are reported by the process-exit gate,
     * and calling them "insecure defaults" would mislabel a config typo.</p>
     */
    static final String SECURITY_WARN_SIGNATURE = "Insecure default configuration detected";
    static final String SECURITY_REFUSED_SIGNATURE =
            "Refusing to start: insecure default configuration in prod mode";

    /** One CP log line that proves the packaged product is running with insecure defaults. */
    record SecurityLogSignature(String signature, String severity, String source) {
        String describe() {
            return severity + " " + source + " \"" + signature + "\"";
        }
    }

    /**
     * BL-204 A①: the explicit security-level list, verbatim literals owned by the CP.
     *
     * <p>Ordering is intentional: the prod refusal (ERROR) is checked first so a log that contains
     * both reports the refusal rather than the warning. Each {@code source} cites the CP file and
     * line that emits the text — that citation is the thing the test suite pins, so an upstream
     * wording change fails here instead of silently disarming the gate.</p>
     */
    static final List<SecurityLogSignature> SECURITY_LOG_SIGNATURES = List.of(
            new SecurityLogSignature(SECURITY_REFUSED_SIGNATURE, "ERROR",
                    "packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/SecurityDefaultsValidator.java:45"),
            new SecurityLogSignature(SECURITY_WARN_SIGNATURE, "WARN",
                    "packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/SecurityDefaultsValidator.java:49"));

    /** Exit code for a security-policy refusal (user ruling Q-2, 2026-11-03). */
    static final int EXIT_SECURITY = 4;

    /** The packaged product always runs the CP in prod mode; one constant, no second opinion. */
    static final String SECURITY_ENV_CP = "prod";

    static final String CODE_SECRETS_MISSING = "LAUNCHER_INSECURE_SECRETS_MISSING";
    static final String CODE_SECURITY_DEFAULTS = "LAUNCHER_SECURITY_DEFAULTS_REJECTED";

    /**
     * BL-204 A② (2026-11-04): the secrets file exists but its DACL/POSIX mode could not be proven
     * owner-only. This is a refusal, not a warning: "we wrote the secrets but could not protect
     * them" is exactly the state the packaging security gate exists to prevent, and a WARN in a log
     * nobody reads would silently ship it.
     */
    static final String CODE_SECRETS_ACL = "LAUNCHER_SECRETS_ACL_UNHARDENED";

    /**
     * Enforcement convention, proved by {@code scripts/pkg/launcher-security.test.mjs}: every line
     * that reads the secrets file carries the literal marker {@code launcher-secret-read-ok:} in
     * its comment, so "no bare {@code getProperty} reaches an env map" is a machine-checked
     * invariant instead of a code-review habit. There is deliberately no Java constant for it — a
     * constant that nothing reads would imply enforcement that does not exist.
     */

    /**
     * The 7 properties {@code launcher.properties} must carry. Missing any of them used to flow
     * into {@code ProcessBuilder.environment().putAll(...)}, which on this JDK does <b>not</b>
     * throw: the PLAN-0650 M0 probe showed the child receives the literal 4-character string
     * {@code null}. A secret of {@code null} is non-blank, so the CP's own prod validator reports
     * no violation — the only place this can be caught is here, before {@code spawn}.
     */
    private static final List<String> REQUIRED_SECRET_KEYS = List.of(
            "pg.password", "jwt.secret", "credentials.key", "credentials.fingerprint.key",
            "oauth.encryption.key", "service.token", "admin.password");

    /** The five CP envs the prod validator requires, each paired with its launcher property. */
    private static final Map<String, String> SECURITY_ENV_SOURCES = new LinkedHashMap<>();

    static {
        SECURITY_ENV_SOURCES.put("XIHE_CP_JWT_SECRET", "jwt.secret");
        SECURITY_ENV_SOURCES.put("XIHE_CP_CREDENTIALS_KEY", "credentials.key");
        SECURITY_ENV_SOURCES.put("XIHE_CP_CREDENTIALS_FINGERPRINT_KEY", "credentials.fingerprint.key");
        SECURITY_ENV_SOURCES.put("XIHE_CP_PROVIDER_CREDENTIALS_KEY", "credentials.key");
        SECURITY_ENV_SOURCES.put("XIHE_CP_OAUTH_ENCRYPTION_KEY", "oauth.encryption.key");
    }

    private Launcher() {
    }

    public static void main(String[] argv) {
        Args args;
        try {
            args = Args.parse(argv);
        } catch (RuntimeException error) {
            System.err.println("[launcher] ERROR: " + error.getMessage());
            System.err.println(usage());
            System.exit(2);
            return;
        }
        if (args.help) {
            System.out.println(usage());
            return;
        }
        Launcher launcher = new Launcher();
        int code;
        try {
            code = launcher.run(args);
        } catch (LauncherException error) {
            System.err.println("[launcher] FAILED: " + error.getMessage());
            if (error.hint != null) {
                System.err.println("[launcher] next: " + error.hint);
            }
            // PLAN-0650: the refusal must land in the same file the user is told to read. Before
            // this, a secrets refusal only reached stderr and diagnostic.html, so the installed
            // launcher.log (the documented first place to look) stayed silent about the cause.
            launcher.log("FAILED security=" + error.security + " reason=" + error.getMessage());
            launcher.writeDiagnostic("startup", error.getMessage(), error.hint, List.of());
            code = error.security ? EXIT_SECURITY : 2;
        } catch (Exception error) {
            System.err.println("[launcher] ERROR: " + error);
            launcher.writeDiagnostic("startup", String.valueOf(error), "看 logs/launcher.log", List.of());
            code = 2;
        }
        if (code != 0 && !args.quiet) {
            pauseForDiagnosis();
        }
        System.exit(code);
    }

    private Path installDir;
    private Path appDir;
    private Path payloadDir;
    private Path logsDir;
    private Path dataRoot;
    private Map<String, Integer> ports;
    private Properties secrets;
    private Args args;

    private int run(Args parsed) throws Exception {
        this.args = parsed;
        this.installDir = resolveInstallDir(parsed);
        this.appDir = installDir.resolve("app");
        this.payloadDir = installDir.resolve("payload");
        this.logsDir = installDir.resolve("logs");
        if ("about".equals(parsed.action)) {
            printAbout();
            return 0;
        }
        Files.createDirectories(logsDir);
        this.dataRoot = resolveDataRoot();
        if ("self-check".equals(parsed.action)) {
            // PLAN-0650: a stack-free way to prove the security preconditions (attestation line,
            // missing-key refusal, log gate). Ports are best-effort here: the first-run note wants
            // the CP port, but a fixture install directory has no ports.json.
            this.ports = tryReadPorts(appDir.resolve("ports.json"));
            return selfCheck();
        }
        this.ports = readPorts(appDir.resolve("ports.json"));

        return switch (parsed.action) {
            case "start" -> start();
            case "stop" -> stop();
            default -> status();
        };
    }

    /* ------------------------------------------------------------------ args */

    private static final class Args {
        String action = "status";
        Path install;
        Path scanLog;
        boolean noBrowser;
        boolean quiet;
        boolean cleanupOnFailure;
        boolean help;

        static Args parse(String[] argv) {
            Args args = new Args();
            for (int i = 0; i < argv.length; i++) {
                String token = argv[i];
                switch (token) {
                    case "start", "stop", "status", "about", "self-check" -> args.action = token;
                    case "--install" -> args.install = Path.of(requireValue(argv, ++i, token)).toAbsolutePath().normalize();
                    case "--scan-log" -> args.scanLog =
                            Path.of(requireValue(argv, ++i, token)).toAbsolutePath().normalize();
                    case "--no-browser" -> args.noBrowser = true;
                    case "--quiet" -> args.quiet = true;
                    case "--cleanup-on-failure" -> args.cleanupOnFailure = true;
                    case "--help", "-h" -> args.help = true;
                    default -> throw new IllegalArgumentException("unknown argument " + token);
                }
            }
            return args;
        }

        private static String requireValue(String[] argv, int index, String flag) {
            if (index >= argv.length) {
                throw new IllegalArgumentException(flag + " expects a value");
            }
            return argv[index];
        }
    }

    private static String usage() {
        return """
                usage: Xihe.exe <start|stop|status|about|self-check> [options]

                  --install <dir>        安装目录（默认从 launcher jar 的位置推导：<install>/app/..）
                  --scan-log <file>      self-check：额外扫描该日志文件里的安全默认签名
                  --no-browser           就绪后不自动打开浏览器
                  --quiet                少输出（停止快捷方式用）
                  --cleanup-on-failure   启动失败时回收已启动的进程（默认保留供排查）
                  --help                 本帮助

                phases: pg(tcp) -> cp(/actuator/health) -> agent -> runtime -> ui(same-origin)
                exit: 0 ok, 1 residual/not-up, 2 failure, 4 security-policy refusal
                """;
    }

    /* -------------------------------------------------------------- install */

    private static Path resolveInstallDir(Args args) {
        if (args.install != null) {
            return args.install;
        }
        try {
            Path jar = Path.of(Launcher.class.getProtectionDomain().getCodeSource().getLocation().toURI())
                    .toAbsolutePath().normalize();
            // <install>/app/xihe-launcher.jar -> <install>
            return jar.getParent().getParent();
        } catch (Exception error) {
            throw new LauncherException("无法从 jar 位置推导安装目录：" + error.getMessage(),
                    "用 --install <dir> 显式指定安装目录");
        }
    }

    private static Path resolveDataRoot() {
        String localAppData = System.getenv("LOCALAPPDATA");
        if (localAppData != null && !localAppData.isBlank()) {
            return Path.of(localAppData).resolve("Xihe");
        }
        return Path.of(System.getProperty("user.home", ".")).resolve(".xihe");
    }

    private Map<String, Integer> readPorts(Path file) throws IOException {
        if (!Files.isRegularFile(file)) {
            throw new LauncherException("ports.json 不存在：" + file,
                    "安装包不完整：ports.json 由构建期从 scripts/lib/stack-ports.mjs 生成（D32-11），重新安装即可");
        }
        String text = Files.readString(file, StandardCharsets.UTF_8);
        Map<String, Integer> parsed = new LinkedHashMap<>();
        Matcher matcher = Pattern.compile("\"(ui|cp|agent|runtime|postgres)\"\\s*:\\s*(\\d+)").matcher(text);
        while (matcher.find()) {
            parsed.put(matcher.group(1), Integer.parseInt(matcher.group(2)));
        }
        for (String key : List.of("ui", "cp", "agent", "runtime", "postgres")) {
            if (!parsed.containsKey(key)) {
                throw new LauncherException("ports.json 缺端口 " + key + "：" + file,
                        "ports.json 由构建期生成，缺键说明构建产物被改坏了；重新安装");
            }
        }
        return parsed;
    }

    /* -------------------------------------------------------------- secrets */

    private Properties loadOrCreateSecrets() throws IOException {
        Path dir = dataRoot.resolve("secrets");
        Files.createDirectories(dir);
        Path file = dir.resolve(ENV_FILE);
        Properties props = new Properties();
        if (Files.isRegularFile(file)) {
            try (InputStream in = Files.newInputStream(file)) {
                props.load(in);
            }
            // PLAN-0650 A-2 gap: "created by us" is not the same as "protected". Every install
            // upgraded from a launcher older than BL-204 A② has this file already, and the ACEs it
            // inherited from %LOCALAPPDATA% would never be revisited — so the create-path hardening
            // would say nothing about the file this start is about to hand to the child.
            rehardenExistingSecrets(file, dir);
            return props;
        }
        SecureRandom random = new SecureRandom();
        props.setProperty("pg.password", randomToken(random, 32));
        props.setProperty("jwt.secret", randomToken(random, 48));
        props.setProperty("credentials.key", randomBase64(random, 32));
        props.setProperty("credentials.fingerprint.key", randomBase64(random, 32));
        props.setProperty("oauth.encryption.key", randomBase64(random, 32));
        props.setProperty("service.token", randomToken(random, 40));
        // The CP seeds `admin@xihe.local` as the instance owner on every non-local-mode boot and
        // assigns SUPER_ADMIN to it (DataSeeder). Without this env the password would be a random
        // value that exists only as a hash — i.e. the instance owner could never log in and nobody
        // could configure an LLM provider. Pinning it to a generated, persisted secret is the
        // minimum viable onboarding for a per-user install; the human-readable copy is
        // %LOCALAPPDATA%\Xihe\FIRST-RUN.txt (see writeFirstRunNote).
        props.setProperty("admin.password", randomToken(random, 24));
        if (!persistSecrets(props, file)) {
            // Another launcher won the create race between the existence check and the move.
            Properties existing = new Properties();
            try (InputStream in = Files.newInputStream(file)) {
                existing.load(in);
            }
            return existing;
        }
        writeFirstRunNote(requireSecret(props, "admin.password"));
        return props;
    }

    /**
     * PLAN-0650 A-2: write the secrets atomically, then hand them back with an owner-only DACL.
     *
     * <p>Why this matters beyond tidiness: the previous path streamed {@code props.store} straight
     * into the target, so a crash mid-write left a truncated file that the next start loaded as
     * "0 of 7 keys" — and (M0 probe) those missing keys then reached the child as the literal
     * string {@code null} rather than failing loudly. Atomicity plus a validated read are the two
     * halves of A-2/A-3.
     *
     * @return {@code true} when this call created the file, {@code false} when another process won
     */
    private boolean persistSecrets(Properties props, Path file) throws IOException {
        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        Files.deleteIfExists(tmp);
        try (OutputStream out = Files.newOutputStream(tmp, StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE)) {
            props.store(out, "Xihe first-run secrets (generated once, never leaves this machine)");
            out.flush();
        }
        // BL-204 A② (2026-11-04): harden BEFORE the move, and treat failure as a refusal. The old
        // file (if any) is therefore still in place when hardening fails — no half-protected
        // secrets file is ever published. The parent directory is hardened for the same reason
        // (a world-writable directory can re-ACL the file) and also before the move, because the
        // tmp file lives in that same directory.
        try {
            hardenPermissions(tmp);
            hardenPermissions(file.getParent());
        } catch (LauncherException failure) {
            Files.deleteIfExists(tmp);
            throw failure;
        }
        if (Files.exists(file)) {
            Files.deleteIfExists(tmp);
            log("secrets: another launcher created " + file + " concurrently; reusing it");
            return false;
        }
        Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE);
        // The ACL travels with the file object across ATOMIC_MOVE; re-asserting it here would be a
        // second opinion on a state we just proved. Verify instead (read-only, no re-set): if the
        // read-back is wrong something external changed the file between move and check, and that
        // must be loud.
        verifyHardened(file);
        log("secrets: wrote " + file + " (" + props.size() + " keys, atomic move, owner-only ACL)");
        return true;
    }

    /**
     * PLAN-0650 A-2 gap (2026-11-06): re-assert the owner-only DACL when an <b>existing</b>
     * secrets file is loaded, not only when one is created.
     *
     * <p>Why the create path alone is not enough: a file written before BL-204 A②, or carried over
     * by an in-place upgrade, keeps the ACEs it inherited from {@code %LOCALAPPDATA%} (SYSTEM,
     * BUILTIN\Administrators, the current user) for as long as nobody touches it again, and the
     * readiness/create-time verification never sees it. Re-asserting on every load is idempotent
     * for an already-hardened file and closes that upgrade path without a migration step; the
     * parent directory is included because a writable directory can re-ACL the file it holds.
     *
     * <p>Failure is a refusal, not a warning: if the DACL cannot be re-proven, the previous ACL is
     * restored and {@link #CODE_SECRETS_ACL} is thrown (exit 4), exactly as on the create path —
     * secrets the launcher cannot prove owner-only must not be read.
     */
    private void rehardenExistingSecrets(Path file, Path dir) {
        hardenPermissions(file);
        hardenPermissions(dir);
        verifyHardened(file);
        log("security: acl existing " + file.getFileName() + " re-asserted on load");
    }

    /**
     * PLAN-0650 A-2 (user ruling Q-1, 2026-11-03) + BL-204 A② (2026-11-04): DACL = file owner +
     * SYSTEM, inherited ACEs dropped. {@code AclFileAttributeView} rather than icacls: Windows has
     * no POSIX mode, and an in-process ACL write has no shell-quoting or locale trap. On a
     * non-Windows filesystem the same intent is expressed as POSIX mode {@code 600}.
     *
     * <p><b>Failure is a refusal, not a warning.</b> The old behaviour logged
     * {@code WARN: could not harden the DACL …} and continued, which is indistinguishable from
     * success for every consumer of the installer — the whole point of the gate is that a secrets
     * file the launcher cannot prove owner-only must not be used. The previous ACL is restored
     * first (a broken DACL must never lock the user out of their own secrets) and then
     * {@link #CODE_SECRETS_ACL} is thrown; {@code persistSecrets} deletes the tmp file and leaves
     * any pre-existing secrets file untouched.
     */
    private void hardenPermissions(Path target) {
        AclFileAttributeView acl = Files.getFileAttributeView(target, AclFileAttributeView.class);
        if (acl != null) {
            hardenAcl(acl, target);
            return;
        }
        PosixFileAttributeView posix = Files.getFileAttributeView(target, PosixFileAttributeView.class);
        if (posix != null) {
            hardenPosix(posix, target);
            return;
        }
        throw new LauncherException(CODE_SECRETS_ACL + ": " + target
                + " 既没有 ACL 视图也没有 POSIX 权限视图，无法收紧到仅当前用户",
                "把 secrets 目录放到 NTFS（Windows）或 ext4/xfs（Linux）；不要用 FAT/网络盘", true);
    }

    private void hardenAcl(AclFileAttributeView view, Path target) {
        List<AclEntry> hardened = new ArrayList<>();
        try {
            hardened.add(fullControl(view.getOwner()));
            UserPrincipal system = lookupSystemPrincipal(target);
            if (system != null) {
                hardened.add(fullControl(system));
            }
            view.setAcl(hardened);
            List<AclEntry> readBack = view.getAcl();
            if (readBack.size() < hardened.size()) {
                throw new IOException("ACL read-back has " + readBack.size() + " of "
                        + hardened.size() + " entries");
            }
            log("security: acl " + target.getFileName() + " entries=" + readBack.size()
                    + " (owner+SYSTEM, inherited dropped)");
        } catch (IOException | RuntimeException failure) {
            restoreAcl(view, target);
            throw new LauncherException(CODE_SECRETS_ACL + ": 无法收紧 DACL " + target
                    + "（" + failure.getMessage() + "）",
                    "检查该文件是否被占用/被组策略锁定；secrets 不能被证明为仅当前用户可读就不启动", true);
        }
    }

    private void hardenPosix(PosixFileAttributeView view, Path target) {
        Set<PosixFilePermission> ownerOnly = EnumSet.of(
                PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE);
        try {
            view.setPermissions(ownerOnly);
            Set<PosixFilePermission> readBack = view.readAttributes().permissions();
            if (!readBack.equals(ownerOnly)) {
                throw new IOException("POSIX read-back is " + readBack);
            }
            log("security: posix " + target.getFileName() + " mode=600");
        } catch (IOException | RuntimeException failure) {
            throw new LauncherException(CODE_SECRETS_ACL + ": 无法收紧 POSIX 权限 " + target
                    + "（" + failure.getMessage() + "）",
                    "chmod 600 失败通常意味着文件系统不支持 POSIX 权限或文件被占用", true);
        }
    }

    /** Read-only re-check after the atomic move; never re-sets, only refuses. */
    private void verifyHardened(Path target) {
        try {
            AclFileAttributeView acl = Files.getFileAttributeView(target, AclFileAttributeView.class);
            if (acl != null) {
                if (acl.getAcl().isEmpty()) {
                    throw new IOException("ACL read-back is empty");
                }
                return;
            }
            PosixFileAttributeView posix = Files.getFileAttributeView(target, PosixFileAttributeView.class);
            if (posix != null
                    && !posix.readAttributes().permissions().equals(EnumSet.of(
                            PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE))) {
                throw new IOException("POSIX mode changed after the move: "
                        + posix.readAttributes().permissions());
            }
        } catch (IOException | RuntimeException failure) {
            throw new LauncherException(CODE_SECRETS_ACL + ": secrets 文件写好后权限校验失败 "
                    + target + "（" + failure.getMessage() + "）",
                    "文件在 move 之后被外部改动（同步盘/杀软）；改用本地非同步目录", true);
        }
    }

    private void restoreAcl(AclFileAttributeView view, Path target) {
        try {
            List<AclEntry> current = view.getAcl();
            view.setAcl(current);
            log("WARN: ACL for " + target.getFileName()
                    + " left as read back (" + current.size() + " entries); verify with icacls");
        } catch (IOException | RuntimeException rollbackFailure) {
            log("ERROR: ACL rollback failed for " + target + ": " + rollbackFailure);
        }
    }

    private UserPrincipal lookupSystemPrincipal(Path target) {
        try {
            return target.getFileSystem().getUserPrincipalLookupService().lookupPrincipalByName("SYSTEM");
        } catch (IOException | RuntimeException failure) {
            log("WARN: SYSTEM principal lookup failed for " + target + " (" + failure.getMessage()
                    + "); hardening to the owner only");
            return null;
        }
    }

    private static AclEntry fullControl(UserPrincipal principal) {
        return AclEntry.newBuilder()
                .setType(AclEntryType.ALLOW)
                .setPrincipal(principal)
                .setPermissions(EnumSet.allOf(AclEntryPermission.class))
                .build();
    }

    /* --------------------------------------------------- PLAN-0650 A-3: fail-closed secrets */

    /**
     * The only sanctioned reader of {@code launcher.properties}.
     *
     * <p>Every secret must come through here: a missing key has to be a named refusal (exit 4)
     * instead of a {@code null} that the child receives as the literal 4-character string
     * {@code null} (PLAN-0650 M0 probe). Each read carries the literal marker
     * {@code launcher-secret-read-ok:} in its comment, so
     * {@code scripts/pkg/launcher-security.test.mjs} can prove no bare read slipped back in.
     */
    private static String requireSecret(Properties props, String key) {
        String value = props.getProperty(key); // launcher-secret-read-ok: the sanctioned reader
        if (value == null || value.isBlank()) {
            throw new LauncherException(CODE_SECRETS_MISSING + ": launcher.properties 缺键 `" + key + "`",
                    "secrets 文件被截断或手工改坏了。从备份恢复 secrets\\launcher.properties；"
                            + "不会自动重建密钥（重建会让既有密文不可读）", true);
        }
        return value;
    }

    /** Pre-flight sweep: report every missing key in one refusal instead of one start per key. */
    private void requireAllSecrets(Properties props) {
        List<String> missing = new ArrayList<>();
        for (String key : REQUIRED_SECRET_KEYS) {
            String value = props.getProperty(key); // launcher-secret-read-ok: pre-flight sweep
            if (value == null || value.isBlank()) {
                missing.add(key);
            }
        }
        if (!missing.isEmpty()) {
            throw new LauncherException(CODE_SECRETS_MISSING + ": launcher.properties 缺 "
                    + missing.size() + " 个键 [" + String.join(", ", missing) + "]",
                    "secrets 文件被截断或手工改坏了：从备份恢复 " + dataRoot.resolve("secrets").resolve(ENV_FILE)
                            + "；不会自动重建密钥（重建会让既有凭据密文永久不可读）", true);
        }
    }

    /* ------------------------------------------------- PLAN-0650 A-1: prove it, don't assume */

    /**
     * Build the five CP security envs from the secrets and the three {@code ALLOW_DEV_KEY=false}
     * switches. The {@code keys=5/5} attestation counts exactly what the CP validator will see,
     * so the positive evidence and the negative gate are computed from one source.
     *
     * <p>Two inherited rationales are preserved here on purpose: the Runtime decrypts
     * credential/OAuth payloads with the <b>same</b> keys and its own prod validator refuses a
     * blank one (measured before PLAN-0632: runtime exit 1 "Insecure default configuration
     * rejected in prod mode" when only the CP received them); and PLAN-0553 retired the
     * provider-credentials domain while both validators still require a real key in prod, so
     * reusing the credentials key keeps the legacy knob unable to fall back to a public constant.
     */
    private Map<String, String> securityEnv(Properties props) {
        Map<String, String> env = new LinkedHashMap<>();
        List<String> missing = new ArrayList<>();
        for (Map.Entry<String, String> entry : SECURITY_ENV_SOURCES.entrySet()) {
            String value = props.getProperty(entry.getValue()); // launcher-secret-read-ok: attestation source
            if (value == null || value.isBlank()) {
                missing.add(entry.getKey() + "<-" + entry.getValue());
            } else {
                env.put(entry.getKey(), value);
            }
        }
        if (!missing.isEmpty()) {
            throw new LauncherException(CODE_SECRETS_MISSING + ": CP 安全 env 无法组装（缺 "
                    + String.join(", ", missing) + "）",
                    "launcher.properties 缺键；不会自动重建密钥", true);
        }
        env.put("XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY", "false");
        env.put("XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY", "false");
        env.put("XIHE_CP_OAUTH_ALLOW_DEV_KEY", "false");
        return env;
    }

    /**
     * PLAN-0650 A-1 positive evidence: one greppable line saying what the launcher is about to
     * hand the CP. This is the <b>intent</b>; the negative gate below is the <b>proof</b>, because
     * only the CP's own log can say which mode it actually booted in.
     */
    private void attestSecurity(String envName, Map<String, String> securityEnv) {
        int required = SECURITY_ENV_SOURCES.size();
        int present = 0;
        for (String key : SECURITY_ENV_SOURCES.keySet()) {
            String value = securityEnv.get(key);
            if (value != null && !value.isBlank()) {
                present++;
            }
        }
        boolean allowDevKeys = devKeyFallbackEnabled(securityEnv);
        log("security: env=" + envName + " keys=" + present + "/" + required
                + " allowDevKeys=" + allowDevKeys);
        if (present < required || allowDevKeys) {
            throw new LauncherException(CODE_SECURITY_DEFAULTS + ": security 前置条件不满足 (keys="
                    + present + "/" + required + ", allowDevKeys=" + allowDevKeys + ")",
                    "密钥未送达时 CP 会在非 prod 模式接受工厂默认值并照常启动；先修 launcher.properties", true);
        }
    }

    private static boolean devKeyFallbackEnabled(Map<String, String> env) {
        for (String key : List.of("XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY",
                "XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY", "XIHE_CP_OAUTH_ALLOW_DEV_KEY")) {
            if ("true".equalsIgnoreCase(env.get(key))) {
                return true;
            }
        }
        return false;
    }

    /**
     * PLAN-0650 A-1 negative gate: scan the CP's own logs for the two security signatures.
     *
     * <p>Runs on <b>every</b> cp outcome (ready / process-exited / timeout), because the dangerous
     * case is the one that reaches health 200: a CP booted with {@code XIHE_ENV != prod} accepts
     * factory defaults, logs a WARN and looks perfectly healthy. Waiting for the child to exit
     * (the old behaviour) can therefore never prove anything.
     *
     * <p>Both streams are scanned on purpose: which stream logback's console appender writes to is
     * the CP's business, not the launcher's, so betting on one stream would bet on an
     * implementation detail.
     */
    private String scanCpSecurityLogs() {
        for (Path candidate : List.of(logsDir.resolve("cp.out.log"), logsDir.resolve("cp.err.log"))) {
            String violation = scanLogFile(candidate);
            if (violation != null) {
                return violation;
            }
        }
        return null;
    }

    /** @return a one-line finding, or {@code null} when the file is absent/clean */
    private String scanLogFile(Path file) {
        if (file == null || !Files.isRegularFile(file)) {
            return null;
        }
        try {
            String text = Files.readString(file, StandardCharsets.UTF_8);
            // BL-204 A①: iterate the explicit table, not a keyword. The finding names which
            // signature matched and the CP file:line that emits it, so a refusal in launcher.log is
            // attributable without re-reading the CP source.
            for (SecurityLogSignature candidate : SECURITY_LOG_SIGNATURES) {
                int at = text.indexOf(candidate.signature());
                if (at >= 0) {
                    return file.getFileName() + ": [" + candidate.describe() + "] " + excerpt(text, at);
                }
            }
            return null;
        } catch (IOException unreadable) {
            log("WARN: cannot read " + file + " for the security scan: " + unreadable.getMessage());
            return null;
        }
    }

    private static String excerpt(String text, int at) {
        int from = Math.max(0, at - 60);
        int to = Math.min(text.length(), at + 200);
        return text.substring(from, to).replaceAll("\\R", " ").trim();
    }

    /**
     * PLAN-0650: stack-free proof of the security preconditions — creates/validates the secrets,
     * emits the same attestation line the real start emits, and optionally runs the log gate over
     * a supplied file ({@code --scan-log}). It spawns nothing and binds no port, so it is safe in
     * CI and inside a fixture install directory.
     */
    private int selfCheck() throws IOException {
        Files.createDirectories(dataRoot);
        this.secrets = loadOrCreateSecrets();
        requireAllSecrets(secrets);
        Map<String, String> securityEnv = securityEnv(secrets);
        attestSecurity(SECURITY_ENV_CP, securityEnv);
        if (args.scanLog != null) {
            String violation = scanLogFile(args.scanLog);
            if (violation != null) {
                throw new LauncherException(
                        CODE_SECURITY_DEFAULTS + ": 日志命中安全默认签名 → " + violation,
                        "CP 以非 prod 模式接受了工厂默认密钥；检查传给 CP 的 XIHE_ENV 与 5 个密钥", true);
            }
            log("self-check: scan-log clean " + args.scanLog);
        }
        System.out.println("[launcher] self-check OK");
        return 0;
    }

    private Map<String, Integer> tryReadPorts(Path file) {
        try {
            return readPorts(file);
        } catch (IOException | RuntimeException unavailable) {
            log("self-check: ports.json 不可用（" + unavailable.getMessage() + "）；端口相关检查跳过");
            return null;
        }
    }

    /** One-time human-readable bootstrap note. Contains a local-only credential by design. */
    private void writeFirstRunNote(String adminPassword) {
        Path note = dataRoot.resolve("FIRST-RUN.txt");
        if (Files.exists(note)) {
            return;
        }
        String cpPort = ports == null ? "<ports.json 缺失>" : String.valueOf(ports.get("cp"));
        String text = String.join(System.lineSeparator(),
                "XH 首次启动说明（本文件由启动器生成，可随时删除）",
                "==================================================",
                "",
                "浏览器地址: http://127.0.0.1:" + cpPort + "/",
                "",
                "初始管理员账号（安装时随机生成，仅本机有效）:",
                "  email:    admin@xihe.local",
                "  password: " + adminPassword,
                "",
                "用法:",
                "  1) 双击桌面 / 开始菜单的「启动 XH」，等浏览器自动打开；",
                "  2) 用上面的管理员账号登录；",
                "  3) 首次使用还需要：新建工作区（选择本机目录）+ 在设置里配置一个模型供应商（API Key）。",
                "     本版本没有引导向导，也没有内置模型额度——模型回复依赖你自己配置的供应商。",
                "",
                "这个密码保存在，也可在 " + dataRoot.resolve("secrets").resolve(ENV_FILE) + " 里查看 admin.password。",
                "注意: 本版本没有「忘记密码」重置入口；丢了密码只能停止 XH 后删除 " + dataRoot.resolve("data")
                        + " 重新初始化（会丢数据）。",
                "",
                "排查: 安装目录 logs\\launcher.log（每次启动的五个阶段与探针），"
                        + "以及同一目录下的 cp/agent/runtime/pg 日志。",
                "");
        try {
            Files.writeString(note, text, StandardCharsets.UTF_8);
            hardenPermissions(note);
            log("first-run: wrote " + note + " (initial admin credentials + startup notes)");
        } catch (IOException error) {
            log("WARN: could not write FIRST-RUN.txt: " + error.getMessage());
        }
    }

    private static String randomToken(SecureRandom random, int length) {
        String alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        StringBuilder builder = new StringBuilder(length);
        for (int i = 0; i < length; i++) {
            builder.append(alphabet.charAt(random.nextInt(alphabet.length())));
        }
        return builder.toString();
    }

    private static String randomBase64(SecureRandom random, int bytes) {
        byte[] buffer = new byte[bytes];
        random.nextBytes(buffer);
        return Base64.getEncoder().encodeToString(buffer);
    }

    /* --------------------------------------------------------------- first run */

    /**
     * Extract the PostgreSQL payload on first run.
     *
     * <p>The payload ships as the zonky `.txz`, share-trimmed at packaging time (PLAN-0632 裁剪③,
     * explicit keep/remove rules in build-installer.mjs PG_SHARE_TRIM; ~19 MiB -> ~75 MiB, 1.4 s
     * measured on the untrimmed payload, PLAN-0632 T2) because Windows ships bsdtar and it
     * extracts `.txz` natively (`tar.exe -xJf`). Payload extraction is idempotent: an existing
     * `pgsql/bin/postgres.exe` wins.
     */
    private void ensurePostgresPayload() throws IOException, InterruptedException {
        Path pgsqlDir = payloadDir.resolve("pgsql");
        Path postgres = pgsqlDir.resolve("bin").resolve("postgres.exe");
        if (Files.isRegularFile(postgres)) {
            installPgvector(pgsqlDir);
            return;
        }
        Path archive = payloadDir.resolve("pgsql.txz");
        if (!Files.isRegularFile(archive)) {
            throw new LauncherException("缺 PostgreSQL 载荷：既没有 " + postgres + "，也没有 " + archive,
                    "安装包不完整（payload/pgsql.txz 缺失），重新安装");
        }
        log("first-run: extracting " + archive.getFileName() + " (" + Files.size(archive) / (1024 * 1024)
                + " MiB -> ~75 MiB share-trimmed, PLAN-0632③)");
        Files.createDirectories(pgsqlDir);
        int code = runProcess(List.of("tar.exe", "-xJf", archive.toString(), "-C", pgsqlDir.toString()),
                pgsqlDir, "tar").exitCode;
        if (code != 0 || !Files.isRegularFile(postgres)) {
            throw new LauncherException("PostgreSQL 载荷解压失败（tar exit=" + code + "）",
                    "磁盘空间不足或安装目录被占用；确认 " + payloadDir + " 可写后重试");
        }
        installPgvector(pgsqlDir);
    }

    /**
     * Install the pgvector files into the extracted PostgreSQL tree.
     *
     * <p>The zonky payload is a server-only rebuild of PostgreSQL and carries no third-party
     * extensions (PLAN-0632 D32-13: 0 matches for `vector` among 1552 entries), while CP's Flyway
     * V1 starts with `CREATE EXTENSION IF NOT EXISTS vector`. The installer therefore ships the
     * pgvector artifacts built against exactly this PostgreSQL version (D32-18: 317.6 KB, ABI
     * verified) and copies them in here — after extraction, because shipping the extracted 104 MiB
     * tree would defeat the `.txz` (already-xz, r=1.0) packaging choice.
     */
    private void installPgvector(Path pgsqlDir) throws IOException {
        Path source = payloadDir.resolve("pgvector");
        if (!Files.isDirectory(source)) {
            throw new LauncherException("缺 pgvector 载荷：" + source,
                    "安装包不完整（payload/pgvector 缺失）；缺它 CP 的 V1 迁移会报 extension \"vector\" is not available");
        }
        copyIfDifferent(source.resolve("lib").resolve("vector.dll"), pgsqlDir.resolve("lib").resolve("vector.dll"));
        Path share = pgsqlDir.resolve("share").resolve("extension");
        Files.createDirectories(share);
        copyIfDifferent(source.resolve("share").resolve("extension").resolve("vector.control"),
                share.resolve("vector.control"));
        copyIfDifferent(source.resolve("share").resolve("extension").resolve("vector--0.8.7.sql"),
                share.resolve("vector--0.8.7.sql"));
        copyIfDifferent(source.resolve("LICENSE-pgvector.txt"), pgsqlDir.resolve("LICENSE-pgvector.txt"));
    }

    private void copyIfDifferent(Path from, Path to) throws IOException {
        if (!Files.isRegularFile(from)) {
            throw new LauncherException("载荷文件缺失：" + from, "安装包不完整，重新安装");
        }
        Files.createDirectories(to.getParent());
        if (Files.isRegularFile(to) && Files.size(to) == Files.size(from)) {
            return;
        }
        Files.copy(from, to, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        log("payload: installed " + to.getFileName());
    }

    /**
     * Create the cluster on first run — and only the cluster.
     *
     * <p>Role, database and `CREATE EXTENSION vector` are deliberately **not** done here: they are
     * done by {@link #bootstrapDatabase()} over a real JDBC/TCP connection once PostgreSQL is
     * listening. The reasons are measured (PLAN-0632 D32-13/15):
     * <ul>
     *   <li>the zonky payload has no psql/createdb/pg_isready, so the only SQL client on a clean
     *       machine is the JDBC driver the installer already ships;</li>
     *   <li>`postgres --single` exits 0 even when the SQL failed (D32-13), so an exit code (or a
     *       "file exists" check) is not evidence; every bootstrap step must end with a SELECT that
     *       returns a row;</li>
     *   <li>host auth is scram-sha-256 with a generated password (D32-12) and only loopback is
     *       bound. `--auth-local=trust` lets the single-user initdb path run without a password.</li>
     * </ul>
     *
     * <p>Idempotent: an existing `data/pg/PG_VERSION` is left untouched (the second start prints
     * "existing cluster" and does no initdb work).
     */
    private void ensurePostgresCluster() throws IOException, InterruptedException {
        Path pgData = dataRoot.resolve("data").resolve("pg");
        Files.createDirectories(pgData);
        Path binDir = payloadDir.resolve("pgsql").resolve("bin");
        Path initdb = binDir.resolve("initdb.exe");
        Path postgres = binDir.resolve("postgres.exe");
        if (!Files.isRegularFile(initdb) || !Files.isRegularFile(postgres)) {
            throw new LauncherException("PostgreSQL 载荷不完整（缺 initdb.exe/postgres.exe）：" + binDir,
                    "重新安装或检查杀软是否隔离了 payload/pgsql");
        }
        if (Files.isRegularFile(pgData.resolve("PG_VERSION"))) {
            String version = Files.readString(pgData.resolve("PG_VERSION"), StandardCharsets.UTF_8).trim();
            log("first-run: SKIP initdb — existing cluster " + pgData + " (PG_VERSION=" + version
                    + "); role/database/extension will be re-verified over JDBC");
            return;
        }
        log("first-run: initdb " + pgData + " (measured 1.71 s, PLAN-0632 T1)");
        Path passwordFile = dataRoot.resolve("secrets").resolve("pg-password.initdb");
        Files.writeString(passwordFile, requireSecret(secrets, "pg.password"), StandardCharsets.UTF_8);
        ProcessResult init = runProcess(List.of(
                initdb.toString(),
                "-D", pgData.toString(),
                "-U", "xihe",
                "--auth-local=trust",
                "--auth-host=scram-sha-256",
                "--pwfile=" + passwordFile,
                "--encoding=UTF8",
                "--locale=C"), binDir, "initdb");
        Files.deleteIfExists(passwordFile);
        if (init.exitCode != 0 || !Files.isRegularFile(pgData.resolve("PG_VERSION"))) {
            throw new LauncherException("initdb 失败（exit=" + init.exitCode + "）：" + tail(init.output),
                    "看 logs/launcher.log 的 initdb 输出；常见原因是 data/pg 不可写或磁盘空间不足");
        }
        log("first-run: initdb OK — data cluster at " + pgData);
    }

    /**
     * Create/verify role, database and the `vector` extension over a real TCP connection.
     *
     * <p>Runs on every start (a few catalog SELECTs, idempotent by construction) so a half-broken
     * cluster is caught at startup instead of surfacing as a Flyway error inside the CP. Each step
     * is proved by a query inside {@code DbBootstrap}; its exit code is only a summary. The
     * password travels through the environment (`XIHE_BOOTSTRAP_PG_PASSWORD`), never argv.
     */
    private void bootstrapDatabase() throws IOException, InterruptedException {
        Path dir = payloadDir.resolve("bootstrap");
        Path bootstrapJar = dir.resolve("db-bootstrap.jar");
        Path driverJar = dir.resolve("postgresql.jar");
        Path java = payloadDir.resolve("jre").resolve("bin").resolve("java.exe");
        for (Path required : List.of(bootstrapJar, driverJar, java)) {
            if (!Files.isRegularFile(required)) {
                throw new LauncherException("数据库引导载荷缺失：" + required,
                        "安装包不完整（payload/bootstrap 或 payload/jre 缺失），重新安装");
            }
        }
        String classpath = bootstrapJar + ";" + driverJar;
        ProcessResult result = runProcess(
                List.of(java.toString(), "-cp", classpath, "DbBootstrap",
                        "--host", "127.0.0.1",
                        "--port", String.valueOf(ports.get("postgres")),
                        "--user", "xihe",
                        "--database", "xihe_1"),
                dir,
                "db-bootstrap",
                Map.of("XIHE_BOOTSTRAP_PG_PASSWORD", requireSecret(secrets, "pg.password")));
        appendLog(indent(result.output));
        if (result.exitCode != 0) {
            throw new LauncherException("数据库引导失败（exit=" + result.exitCode + "）：" + tail(result.output),
                    "看 logs/launcher.log 的 db-bootstrap 输出：缺 vector.control 说明 pgvector 载荷没装进 pgsql/share/extension");
        }
        for (String line : result.output.split("\\R")) {
            if (!line.isBlank()) {
                log("db-bootstrap: " + line.trim());
            }
        }
        log("step=pg bootstrap verified over TCP+SELECT (role, database, extension vector)");
    }

    /* --------------------------------------------------------------- services */

    private Map<String, ServiceSpec> services() {
        Map<String, ServiceSpec> services = new LinkedHashMap<>();
        Path pgData = dataRoot.resolve("data").resolve("pg");
        Path jre = payloadDir.resolve("jre").resolve("bin").resolve("java.exe");
        int pgPort = ports.get("postgres");
        int cpPort = ports.get("cp");
        int agentPort = ports.get("agent");
        int runtimePort = ports.get("runtime");
        String password = requireSecret(secrets, "pg.password");
        String token = requireSecret(secrets, "service.token");
        String cpUrl = "http://127.0.0.1:" + cpPort;

        Map<String, String> common = new LinkedHashMap<>();
        common.put("XIHE_ENV", SECURITY_ENV_CP);
        common.put("XIHE_LOAD_DOTENV", "0");
        common.put("XIHE_STACK_ID", "stack-1");
        common.put("XIHE_LOG_DIR", logsDir.toString());
        common.put("XIHE_PG_DSN", "postgresql+psycopg://xihe:" + password + "@127.0.0.1:" + pgPort + "/xihe_1");
        common.put("XIHE_CP_URL", cpUrl);
        common.put("XIHE_CP_BASE_URL", cpUrl);
        common.put("XIHE_CP_API_TOKEN", token);
        common.put("XIHE_AGENT_API_TOKEN", token);
        // PLAN-0650 A-1/A-3: the five CP security envs plus the three "no dev fallback" switches
        // come from ONE builder, so "what we attest" and "what we pass" cannot drift apart.
        // Secrets are read through requireSecret(): a missing key is a named refusal here instead
        // of a null that the child would receive as the literal string "null" (M0 probe).
        common.putAll(securityEnv(secrets));

        services.put("pg", new ServiceSpec(
                "pg",
                payloadDir.resolve("pgsql").resolve("bin").resolve("postgres.exe"),
                List.of("-D", pgData.toString(), "-p", String.valueOf(pgPort), "-c", "listen_addresses=127.0.0.1"),
                payloadDir.resolve("pgsql").resolve("bin"),
                pgPort,
                null,
                Map.of(),
                PG_TIMEOUT_MS));

        Map<String, String> cpEnv = new LinkedHashMap<>(common);
        cpEnv.put("XIHE_CP_PORT", String.valueOf(cpPort));
        cpEnv.put("SERVER_ADDRESS", "127.0.0.1");
        cpEnv.put("XIHE_CP_DATASOURCE_URL", "jdbc:postgresql://127.0.0.1:" + pgPort + "/xihe_1");
        cpEnv.put("XIHE_CP_DATASOURCE_USERNAME", "xihe");
        cpEnv.put("XIHE_CP_DATASOURCE_PASSWORD", password);
        cpEnv.put("XIHE_DEV_ADMIN_PASSWORD", requireSecret(secrets, "admin.password"));
        cpEnv.put("XIHE_AGENT_URL", "http://127.0.0.1:" + agentPort + "/internal/v1/agent/chat");
        cpEnv.put("XIHE_AGENT_BASE_URL", "http://127.0.0.1:" + agentPort);
        cpEnv.put("XIHE_RUNTIME_URL", "http://127.0.0.1:" + runtimePort);
        cpEnv.put("XIHE_UI_STATIC_ROOT", payloadDir.resolve("ui").toString());
        cpEnv.put("XIHE_ATTACHMENTS_BASE_PATH", dataRoot.resolve("data").resolve("attachments").toString());
        cpEnv.put("XIHE_WORKSPACE_HOST_ROOT", dataRoot.resolve("data").resolve("workspaces").toString());
        cpEnv.put("XIHE_RUNTIME_STATE_DIR", dataRoot.resolve("data").resolve("runtime-state").toString());
        cpEnv.put("XIHE_WORKSPACE_DOCKER_BACKEND", "disabled");
        cpEnv.put("XIHE_CHANNEL_ENABLED", "true");
        // XIHE_ENV=prod + XIHE_LOCAL_MODE=true is rejected by SecurityDefaultsValidator (local
        // single-user mode is a dev-only shortcut that disables the login entry). The packaged
        // product therefore keeps the normal register/login flow; a fresh install boots with no
        // accounts and the UI's first screen is registration.
        services.put("cp", new ServiceSpec(
                "cp",
                jre,
                List.of("-XX:+ExitOnOutOfMemoryError", "-jar", payloadDir.resolve("cp").resolve("xihe-control-plane.jar").toString()),
                payloadDir.resolve("cp"),
                cpPort,
                "/actuator/health",
                cpEnv,
                CP_TIMEOUT_MS));

        Map<String, String> agentEnv = new LinkedHashMap<>(common);
        agentEnv.put("XIHE_AGENT_PORT", String.valueOf(agentPort));
        services.put("agent", new ServiceSpec(
                "agent",
                payloadDir.resolve("agent").resolve("xihe-agent-onedir.exe"),
                List.of(),
                payloadDir.resolve("agent"),
                agentPort,
                "/internal/v1/agent/health",
                agentEnv,
                AGENT_TIMEOUT_MS));

        Map<String, String> runtimeEnv = new LinkedHashMap<>(common);
        runtimeEnv.put("XIHE_RUNTIME_PORT", String.valueOf(runtimePort));
        runtimeEnv.put("XIHE_CHANNEL_URL", cpUrl);
        runtimeEnv.put("XIHE_WORKSPACE_IMAGE", "xihe/workspace:latest");
        runtimeEnv.put("XIHE_WORKSPACE_HOST_ROOT", dataRoot.resolve("data").resolve("workspaces").toString());
        runtimeEnv.put("XIHE_RUNTIME_STATE_DIR", dataRoot.resolve("data").resolve("runtime-state").toString());
        services.put("runtime", new ServiceSpec(
                "runtime",
                payloadDir.resolve("runtime").resolve("xihe-runtime.exe"),
                List.of(),
                payloadDir.resolve("runtime"),
                runtimePort,
                "/health",
                runtimeEnv,
                RUNTIME_TIMEOUT_MS));

        // D32-06: the SPA is served by the CP, so the ui phase gates `GET /` on the CP port and
        // spawns nothing. A CP with a broken static mapping is a real failure of "double click ->
        // browser", so it must fail loudly here rather than after the browser opens.
        services.put("ui", new ServiceSpec(
                "ui",
                null,
                List.of(),
                null,
                cpPort,
                "/",
                Map.of(),
                UI_TIMEOUT_MS));
        return services;
    }

    /* ----------------------------------------------------------------- start */

    private int start() throws Exception {
        Files.createDirectories(dataRoot);
        Files.createDirectories(dataRoot.resolve("data").resolve("attachments"));
        Files.createDirectories(dataRoot.resolve("data").resolve("workspaces"));
        Files.createDirectories(dataRoot.resolve("data").resolve("runtime-state"));
        Files.createDirectories(dataRoot.resolve("secrets"));
        // PLAN-0650: the log is truncated BEFORE any work so the first-run lines (payload extract,
        // initdb) and the security attestation survive. Before this change truncation happened
        // after first-run and erased exactly the lines a failed first start needs (PLAN-0632
        // verify §9 #1, the "日志行被 truncateLauncherLog 清掉" debt).
        truncateLauncherLog();
        // A-3 must run before any spawn: a missing key has to be a named refusal (exit 4), never a
        // child that silently receives the literal string "null" as its secret.
        this.secrets = loadOrCreateSecrets();
        requireAllSecrets(secrets);
        // A-1 positive evidence: what we are about to hand the CP. The negative gate below is the
        // real proof, because only the CP's own log can say which mode it actually booted in.
        attestSecurity(SECURITY_ENV_CP, securityEnv(secrets));
        ensurePostgresPayload();
        ensurePostgresCluster();

        log("start install=" + installDir + " data=" + dataRoot
                + " ports ui=" + ports.get("ui") + " cp=" + ports.get("cp") + " agent=" + ports.get("agent")
                + " runtime=" + ports.get("runtime") + " pg=" + ports.get("postgres"));
        log("order: " + String.join(" -> ", PHASE_ORDER) + " (gated)");

        Map<String, ServiceSpec> services = services();
        Map<String, ProcessRecord> previous = readPidFile();
        for (Map.Entry<String, ServiceSpec> entry : services.entrySet()) {
            ProcessRecord prior = previous.get(entry.getKey());
            if (prior != null && prior.pid > 0 && isAlive(prior.pid)) {
                entry.getValue().pid = prior.pid;
                log("step=" + entry.getKey() + " already running pid=" + prior.pid + "; gating on readiness");
            }
        }

        List<ProcessRecord> started = new ArrayList<>();
        for (String name : PHASE_ORDER) {
            ServiceSpec spec = services.get(name);
            if (spec.exe == null) {
                log("step=" + name + " is not launch-owned (same-origin); gating only");
            } else if (spec.pid == 0) {
                if (!Files.isRegularFile(spec.exe)) {
                    return fail(name, "可执行文件不存在：" + spec.exe, PHASE_HINTS.get(name), started);
                }
                log("step=" + name + " spawning " + spec.exe);
                spec.pid = spawn(spec);
                log("step=" + name + " spawned pid=" + spec.pid + " port=" + spec.port
                        + " log=" + logsDir.resolve(name + ".out.log"));
                // Record pids as soon as they exist: if a later phase fails, `--stop` must still be
                // able to find the processes we already started (a failed start must not leak an
                // untracked PostgreSQL, which is exactly what a pid-file-at-the-end design does).
                writePidFile(services);
            }
            ProcessRecord record = new ProcessRecord(name, spec.pid, spec.port, spec.exe == null ? "" : spec.exe.toString(),
                    Instant.now().toString());
            started.add(record);
            long began = System.nanoTime();
            Probe probe = waitForPhase(spec);
            long elapsed = (System.nanoTime() - began) / 1_000_000;
            // PLAN-0650 A-1: the security gate runs on EVERY cp outcome — ready, process-exited and
            // timeout. The dangerous case reaches health 200 (a CP in non-prod mode accepts factory
            // defaults and looks healthy), so gating only on failure would miss it entirely.
            if ("cp".equals(name)) {
                String violation = scanCpSecurityLogs();
                if (violation != null) {
                    if (args.cleanupOnFailure) {
                        stopAll(services, false);
                    }
                    return fail("cp", CODE_SECURITY_DEFAULTS + ": " + violation, PHASE_HINTS.get("cp"),
                            started, EXIT_SECURITY);
                }
            }
            if (!probe.ready) {
                if (args.cleanupOnFailure) {
                    stopAll(services, false);
                }
                return fail(name, probe.state, PHASE_HINTS.get(name), started);
            }
            log("step=" + name + " ready in " + String.format(Locale.ROOT, "%.2f", elapsed / 1000.0) + "s");
            record.readyMs = elapsed;
            if ("pg".equals(name)) {
                // The TCP accept above proves "something listens"; it does not prove the role, the
                // database or the vector extension exist. Bootstrap over JDBC (real TCP + SELECT)
                // before the CP starts, so a broken cluster is a named launcher failure instead of a
                // Flyway stack trace 20 seconds later.
                try {
                    bootstrapDatabase();
                } catch (LauncherException error) {
                    if (args.cleanupOnFailure) {
                        stopAll(services, false);
                    }
                    return fail("pg", error.getMessage(), error.hint, started);
                }
            }
        }

        writePidFile(services);
        String url = "http://127.0.0.1:" + ports.get("cp") + "/";
        System.out.println("[launcher] XH is up");
        for (String name : PHASE_ORDER) {
            ServiceSpec spec = services.get(name);
            System.out.printf("  %-8s pid=%-7s port=%-6s ready in %.2fs%n", name,
                    spec.pid == 0 ? "-" : String.valueOf(spec.pid), String.valueOf(spec.port),
                    spec.lastReadyMs / 1000.0);
        }
        System.out.println("[launcher] URL: " + url);
        System.out.println("[launcher] logs: " + logsDir);
        System.out.println("[launcher] stop: 开始菜单 → 停止 XH（或 launcher --stop）");
        if (!args.noBrowser) {
            openBrowser(url);
        }
        return 0;
    }

    private long slowest(ServiceSpec spec) {
        return spec.lastReadyMs;
    }

    private int fail(String phase, String reason, String hint, List<ProcessRecord> started) throws IOException {
        return fail(phase, reason, hint, started, 2);
    }

    /**
     * PLAN-0650: {@code exitCode} separates a security-policy refusal (4, user ruling Q-2) from a
     * generic startup failure (2). Scripts must be able to tell "the secrets are wrong" from "the
     * CP did not come up" — the two have completely different remediations.
     */
    private int fail(String phase, String reason, String hint, List<ProcessRecord> started, int exitCode)
            throws IOException {

        StringBuilder message = new StringBuilder();
        message.append("step=").append(phase).append(" ").append(reason).append('\n');
        message.append("[launcher] services started before the failure: ");
        if (started.isEmpty()) {
            message.append("none");
        } else {
            List<String> names = new ArrayList<>();
            for (ProcessRecord record : started) {
                if (record.pid > 0) {
                    names.add(record.service + "(pid=" + record.pid + ")");
                }
            }
            message.append(names.isEmpty() ? "none" : String.join(", ", names));
        }
        message.append('\n');
        message.append("[launcher] logs: ").append(logsDir);
        System.err.println(message);
        if (!started.isEmpty()) {
            System.err.println("[launcher] 进程已保留供排查；排查完执行：开始菜单 → 停止 XH（或 launcher --stop）");
        }
        System.err.println("[launcher] next: " + hint);
        log("FAILED step=" + phase + " reason=" + reason);
        writeDiagnostic(phase, reason, hint, started);
        return exitCode;
    }

    /**
     * Make a failed start *visible*, not just logged.
     *
     * <p>The requirement is explicit: a first-run failure must not silently continue into a
     * half-started stack, and it must be readable when the UI never comes up (so there is no
     * "关于/诊断" page served by the CP to look at). The launcher therefore renders a static
     * {@code logs/diagnostic.html} — phase, reason, the exact hint, the processes it started, the
     * log directory, and the "not included in this version" list — and opens it in the default
     * browser. The console output stays as the second, always-available channel.
     */
    private void writeDiagnostic(String phase, String reason, String hint, List<ProcessRecord> started) {
        try {
            Files.createDirectories(logsDir);
            StringBuilder services = new StringBuilder();
            for (ProcessRecord record : started) {
                services.append("<li><code>").append(html(record.service)).append("</code> pid=")
                        .append(record.pid).append(" port=").append(record.port)
                        .append(" ").append(html(record.readyMs > 0 ? "ready" : "not-ready"))
                        .append("</li>\n");
            }
            if (services.isEmpty()) {
                services.append("<li>none</li>\n");
            }
            String notIncluded = "";
            Path notice = appDir.resolve("NOT-INCLUDED.txt");
            if (Files.isRegularFile(notice)) {
                notIncluded = "<pre>" + html(Files.readString(notice, StandardCharsets.UTF_8)) + "</pre>";
            }
            String page = """
                    <!doctype html>
                    <html lang="zh-CN"><head><meta charset="utf-8">
                    <title>XH 启动失败 — 诊断</title>
                    <style>
                      body{font:15px/1.6 "Segoe UI",sans-serif;margin:2.5rem auto;max-width:60rem;padding:0 1.2rem;color:#1f2328}
                      h1{font-size:1.5rem;color:#b42318} code{background:#f2f4f7;padding:.1rem .3rem;border-radius:3px}
                      .box{border:1px solid #e4e7ec;border-radius:8px;padding:1rem 1.2rem;margin:1rem 0}
                      pre{white-space:pre-wrap;background:#f8f9fb;padding:.8rem;border-radius:6px;font-size:13px}
                      .muted{color:#667085;font-size:13px}
                    </style></head><body>
                    <h1>XH 没有启动完成</h1>
                    <p>失败阶段：<code>%s</code></p>
                    <div class="box"><strong>原因</strong><pre>%s</pre></div>
                    <div class="box"><strong>怎么修</strong><pre>%s</pre></div>
                    <div class="box"><strong>已经启动的进程（保留供排查）</strong><ul>%s</ul>
                      <p class="muted">排查完请点开始菜单「停止 XH」，否则这些进程会一直占用 12631–12634 端口。</p></div>
                    <div class="box"><strong>日志目录</strong><pre>%s</pre>
                      <p class="muted">先看 launcher.log（每个阶段的探针时间/URL/HTTP 状态），再看对应服务的 .err.log。</p></div>
                    <div class="box"><strong>本版本未包含的能力</strong>%s</div>
                    </body></html>
                    """.formatted(html(phase), html(reason), html(hint), services, html(logsDir.toString()), notIncluded);
            Path file = logsDir.resolve("diagnostic.html");
            Files.writeString(file, page, StandardCharsets.UTF_8);
            log("diagnostic page: " + file);
            if (!args.noBrowser) {
                openBrowser(file.toUri().toString());
            }
        } catch (IOException error) {
            log("WARN: could not write diagnostic page: " + error.getMessage());
        }
    }

    private static String html(String value) {
        return value == null ? "" : value.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace("\"", "&quot;");
    }

    private int spawn(ServiceSpec spec) throws IOException {
        Files.createDirectories(logsDir);
        List<String> command = new ArrayList<>();
        command.add(spec.exe.toString());
        command.addAll(spec.args);
        ProcessBuilder builder = new ProcessBuilder(command);
        if (spec.cwd != null) {
            builder.directory(spec.cwd.toFile());
        }
        Map<String, String> env = builder.environment();
        String noProxy = env.get("NO_PROXY");
        if (noProxy != null && (noProxy.contains("[") || noProxy.contains("]"))) {
            // Bracketed IPv6 literals break httpx URLPatterns in the Agent (`Invalid port ':1]'`),
            // the same defect scripts/stack-run.mjs and the Node supervisor already scrub.
            env.put("NO_PROXY", scrubNoProxy(noProxy));
            env.put("no_proxy", scrubNoProxy(env.getOrDefault("no_proxy", noProxy)));
        }
        // PLAN-0650 A-3 defence in depth: every secret now goes through requireSecret(), but a
        // future regression must fail HERE (named, exit 4) instead of quietly handing the child the
        // literal string "null" — which is what ProcessBuilder.environment().putAll() does with a
        // null value on this JDK (PLAN-0650 M0 probe, evidence/m0-null-env-probe.md).
        for (Map.Entry<String, String> entry : spec.env.entrySet()) {
            if (entry.getValue() == null) {
                throw new LauncherException(CODE_SECRETS_MISSING + ": 环境变量 " + entry.getKey()
                        + " 的值为 null，拒绝启动（子进程会把它当成字符串 \"null\"）",
                        "这是编码回归：该值必须经 requireSecret() 取得", true);
            }
        }
        env.putAll(spec.env);
        // Fresh instance, fresh logs: the pg readiness gate greps this file, so an old
        // "ready to accept connections" line must not survive a restart.
        Path outLog = logsDir.resolve(spec.name + ".out.log");
        Path errLog = logsDir.resolve(spec.name + ".err.log");
        try {
            Files.deleteIfExists(outLog);
            Files.deleteIfExists(errLog);
        } catch (IOException truncateFailure) {
            log("WARN: could not truncate logs for " + spec.name + ": " + truncateFailure.getMessage());
        }
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(outLog.toFile()));
        builder.redirectError(ProcessBuilder.Redirect.appendTo(errLog.toFile()));
        Process process = builder.start();
        long pid = process.pid();
        // The launcher exits after the stack is up (D32-08); the children must outlive it. On
        // Windows a child process is not tied to the parent's lifetime unless a Job Object says so,
        // and we deliberately do not create one here.
        process.getOutputStream().close();
        return (int) pid;
    }

    static String scrubNoProxy(String value) {
        List<String> kept = new ArrayList<>();
        for (String part : value.split(",")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty() && !trimmed.contains("[") && !trimmed.contains("]")) {
                kept.add(trimmed);
            }
        }
        return String.join(",", kept);
    }

    /* ---------------------------------------------------------------- probes */

    private static final class Probe {
        boolean ready;
        String state = "not-ready";
        Integer httpStatus;
        boolean listening;
        long elapsedMs;
    }

    private Probe waitForPhase(ServiceSpec spec) {
        long startedAt = System.currentTimeMillis();
        long deadline = startedAt + spec.timeoutMs;
        Probe last = new Probe();
        int attempt = 0;
        while (true) {
            attempt++;
            last = probe(spec);
            last.elapsedMs = System.currentTimeMillis() - startedAt;
            logProbe(spec, attempt, last);
            if (last.ready) {
                spec.lastReadyMs = last.elapsedMs;
                return last;
            }
            if (spec.pid > 0 && !isAlive(spec.pid)) {
                last.state = "process exited (pid " + spec.pid + ")";
                log("step=" + spec.name + " process exited before becoming ready");
                return last;
            }
            if (System.currentTimeMillis() >= deadline) {
                return last;
            }
            sleep(POLL_MS);
        }
    }

    private Probe probe(ServiceSpec spec) {
        Probe probe = new Probe();
        if (spec.healthPath == null) {
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("127.0.0.1", spec.port), 1500);
                probe.listening = true;
                // A TCP accept is necessary but not sufficient: PostgreSQL opens the socket before
                // it finishes crash recovery and then answers every connection with
                // "the database system is not yet accepting connections" (measured: the CP's
                // Hikari fail-fast died on exactly that, after a launcher-killed cluster).
                // The payload has no psql/pg_isready (D32-15), so the second gate is PostgreSQL's
                // own readiness line in the log we started with an empty file.
                String readyLine = postgresReadyLine(spec);
                if (readyLine != null) {
                    probe.ready = true;
                    probe.state = "tcp accept + ready to accept connections";
                } else {
                    probe.ready = false;
                    probe.state = "tcp accept; waiting for PostgreSQL 'ready to accept connections'";
                }
            } catch (IOException error) {
                probe.state = "tcp " + error.getMessage();
            }
            return probe;
        }
        String url = "http://127.0.0.1:" + spec.port + spec.healthPath;
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", spec.port), 2000);
            socket.setSoTimeout(4000);
            OutputStream out = socket.getOutputStream();
            String request = "GET " + spec.healthPath + " HTTP/1.0\r\nHost: 127.0.0.1\r\n"
                    + "Connection: close\r\nAccept: text/html,*/*\r\n\r\n";
            out.write(request.getBytes(StandardCharsets.US_ASCII));
            out.flush();
            String response = new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            probe.listening = true;
            Matcher status = Pattern.compile("^HTTP/\\d\\.\\d (\\d{3})").matcher(response);
            if (status.find()) {
                int code = Integer.parseInt(status.group(1));
                probe.httpStatus = code;
                // The UI phase asks for `/` and accepts 200 only; every other gate is exact too.
                probe.ready = code == 200;
                probe.state = "HTTP " + code;
                if (probe.ready && "/".equals(spec.healthPath) && !response.toLowerCase(Locale.ROOT).contains("<html")) {
                    probe.ready = false;
                    probe.state = "HTTP 200 but body is not the SPA (static serving broken?)";
                }
            } else {
                probe.state = "no HTTP status line";
            }
        } catch (IOException error) {
            probe.state = "http " + error.getMessage();
        }
        return probe;
    }

    /**
     * PostgreSQL logs "database system is ready to accept connections" once recovery finishes.
     * The spawn path truncates pg.err.log, so a match can only come from the instance we started.
     */
    private String postgresReadyLine(ServiceSpec spec) {
        Path log = logsDir.resolve(spec.name + ".err.log");
        if (!Files.isRegularFile(log)) {
            return null;
        }
        try {
            String text = Files.readString(log, StandardCharsets.UTF_8);
            int index = text.lastIndexOf("ready to accept connections");
            if (index < 0) {
                return null;
            }
            return text.substring(Math.max(0, index - 80), Math.min(text.length(), index + 40));
        } catch (IOException error) {
            return null;
        }
    }

    private void logProbe(ServiceSpec spec, int attempt, Probe probe) {
        appendLog("probe step=" + spec.name + " attempt=" + attempt + " url=http://127.0.0.1:" + spec.port
                + (spec.healthPath == null ? "" : spec.healthPath)
                + " http=" + (probe.httpStatus == null ? "-" : probe.httpStatus)
                + " listen=" + probe.listening + " state=" + probe.state
                + " elapsed=" + String.format(Locale.ROOT, "%.2fs", probe.elapsedMs / 1000.0));
    }

    /* -------------------------------------------------------------- pid file */

    private Path pidFile() {
        return logsDir.resolve(PID_FILE);
    }

    private Map<String, ProcessRecord> readPidFile() {
        Map<String, ProcessRecord> records = new LinkedHashMap<>();
        Path file = pidFile();
        if (!Files.isRegularFile(file)) {
            return records;
        }
        try {
            String text = Files.readString(file, StandardCharsets.UTF_8);
            Matcher matcher = Pattern.compile(
                    "\"(pg|cp|agent|runtime|ui)\"\\s*:\\s*\\{[^}]*?\"pid\"\\s*:\\s*(\\d+)").matcher(text);
            while (matcher.find()) {
                ProcessRecord record = new ProcessRecord();
                record.service = matcher.group(1);
                record.pid = Integer.parseInt(matcher.group(2));
                records.put(record.service, record);
            }
        } catch (IOException error) {
            log("pid file unreadable: " + error.getMessage());
        }
        return records;
    }

    private void writePidFile(Map<String, ServiceSpec> services) throws IOException {
        Files.createDirectories(logsDir);
        StringBuilder json = new StringBuilder();
        json.append("{\n");
        json.append("  \"stackId\": \"stack-1\",\n");
        json.append("  \"installDir\": ").append(quote(installDir.toString())).append(",\n");
        json.append("  \"startedAt\": ").append(quote(Instant.now().toString())).append(",\n");
        json.append("  \"services\": {\n");
        List<String> entries = new ArrayList<>();
        for (String name : PHASE_ORDER) {
            ServiceSpec spec = services.get(name);
            entries.add("    " + quote(name) + ": {\"pid\": " + spec.pid + ", \"port\": " + spec.port
                    + ", \"exe\": " + quote(spec.exe == null ? "" : spec.exe.toString())
                    + ", \"startedAt\": " + quote(Instant.now().toString()) + "}");
        }
        json.append(String.join(",\n", entries)).append('\n');
        json.append("  }\n}\n");
        Files.writeString(pidFile(), json.toString(), StandardCharsets.UTF_8);
    }

    /* ------------------------------------------------------------------ stop */

    private int stop() throws Exception {
        Map<String, ProcessRecord> records = readPidFile();
        if (records.isEmpty()) {
            System.out.println("[launcher] no pid file at " + pidFile() + " (nothing to stop)");
        }
        // PostgreSQL first, and gracefully: `taskkill` on postgres.exe is a crash and forces WAL
        // recovery on the next start. pg_ctl exists in the zonky payload (postgres/initdb/pg_ctl).
        gracefulPostgresStop();
        int failures = 0;
        if (!records.isEmpty()) {
            for (String name : List.of("ui", "runtime", "agent", "cp", "pg")) {
                ProcessRecord record = records.get(name);
                if (record == null || record.pid <= 0) {
                    continue;
                }
                if (!isAlive(record.pid)) {
                    System.out.println("  stop " + pad(name) + " pid=" + pad(String.valueOf(record.pid)) + " already gone");
                    continue;
                }
                int code = killTree(record.pid);
                System.out.println("  stop " + pad(name) + " pid=" + pad(String.valueOf(record.pid))
                        + " tree exit=" + code);
                if (code != 0 && isAlive(record.pid)) {
                    failures++;
                }
            }
        }
        Files.deleteIfExists(pidFile());
        List<String> residual = residualListeners(records);
        System.out.println("[launcher] residual listeners on our ports: "
                + (residual.isEmpty() ? "none" : String.join(" ", residual)));
        System.out.println("[launcher] pid file removed=" + !Files.exists(pidFile()));
        log("stop residual=" + residual);
        return residual.isEmpty() && failures == 0 ? 0 : 1;
    }

    private void gracefulPostgresStop() {
        Path pgData = dataRoot.resolve("data").resolve("pg");
        Path pgCtl = payloadDir.resolve("pgsql").resolve("bin").resolve("pg_ctl.exe");
        if (!Files.isRegularFile(pgCtl) || !Files.isRegularFile(pgData.resolve("PG_VERSION"))) {
            return;
        }
        ProcessResult result = runProcess(
                List.of(pgCtl.toString(), "stop", "-D", pgData.toString(), "-m", "fast", "-w", "-t", "30"),
                pgCtl.getParent(), "pg_ctl stop");
        log("pg_ctl stop exit=" + result.exitCode + " " + tail(result.output));
    }

    private int killTree(int pid) {
        ProcessResult result = runProcess(List.of("taskkill", "/PID", String.valueOf(pid), "/T", "/F"),
                null, "taskkill");
        return result.exitCode;
    }

    /** Reverse-order teardown used by --cleanup-on-failure. */
    private void stopAll(Map<String, ServiceSpec> services, boolean graceful) {
        for (String name : List.of("ui", "runtime", "agent", "cp", "pg")) {
            ServiceSpec spec = services.get(name);
            if (spec.pid > 0 && isAlive(spec.pid)) {
                killTree(spec.pid);
                System.out.println("[launcher] cleanup-on-failure: killed " + name + " pid=" + spec.pid);
            }
        }
        try {
            Files.deleteIfExists(pidFile());
        } catch (IOException cleanupFailure) {
            log("cleanup-on-failure: pid file not removed: " + cleanupFailure.getMessage());
        }
    }

    private List<String> residualListeners(Map<String, ProcessRecord> records) {
        List<String> residual = new ArrayList<>();
        String output = runProcess(List.of("netstat", "-ano", "-p", "tcp"), null, "netstat").output;
        for (String line : output.split("\r?\n")) {
            String[] parts = line.trim().split("\\s+");
            if (parts.length < 5 || !"TCP".equalsIgnoreCase(parts[0])) {
                continue;
            }
            if (!"LISTENING".equalsIgnoreCase(parts[parts.length - 2])) {
                continue;
            }
            Matcher portMatcher = Pattern.compile(":(\\d+)$").matcher(parts[1]);
            if (!portMatcher.find()) {
                continue;
            }
            int port = Integer.parseInt(portMatcher.group(1));
            boolean ours = ports.values().contains(port);
            if (!ours) {
                continue;
            }
            int pid = Integer.parseInt(parts[parts.length - 1]);
            residual.add(port + "(pid=" + pid + ")");
        }
        return residual;
    }

    /* ---------------------------------------------------------------- status */

    private int status() throws Exception {
        this.secrets = loadOrCreateSecrets();
        Map<String, ProcessRecord> records = readPidFile();
        boolean ok = true;
        System.out.println("[launcher] status stack-1 install=" + installDir);
        Map<String, ServiceSpec> services = services();
        for (String name : PHASE_ORDER) {
            ServiceSpec spec = services.get(name);
            ProcessRecord record = records.get(name);
            Probe probe = probe(spec);
            boolean alive = record != null && isAlive(record.pid);
            System.out.printf("  %-8s pid=%-7s alive=%-5s port=%-6s ready=%-5s state=%s%n",
                    name, record == null ? "-" : String.valueOf(record.pid), alive,
                    String.valueOf(spec.port), probe.ready, probe.state);
            ok &= probe.ready;
        }
        List<String> residual = residualListeners(records);
        System.out.println("[launcher] ports held by processes this launcher does not own: "
                + (residual.isEmpty() ? "none" : String.join(" ", residual)));
        System.out.println("[launcher] " + (ok ? "stack is up" : "stack is not fully up"));
        return ok && residual.isEmpty() ? 0 : 1;
    }

    /* ----------------------------------------------------------------- about */

    private void printAbout() {
        Path notice = appDir.resolve("NOT-INCLUDED.txt");
        System.out.println("XH (Xihe) — 本地 Agent 运行时平台");
        System.out.println("安装目录: " + installDir);
        try {
            System.out.println();
            System.out.println(Files.readString(notice, StandardCharsets.UTF_8));
        } catch (IOException error) {
            System.out.println("本版本未包含：自动更新 / 开机自启与托盘常驻 / 代码签名 / 静默安装 / 卸载数据清理策略 /"
                    + " 多架构 / 端口冲突自动改号 / 崩溃自动重启 / 日志上报（详见 installer-scope）");
        }
    }

    /* --------------------------------------------------------------- helpers */

    private static boolean isAlive(int pid) {
        return ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private void openBrowser(String url) {
        try {
            new ProcessBuilder("cmd.exe", "/c", "start", "", url).start();
            log("opened browser " + url);
        } catch (IOException error) {
            System.err.println("[launcher] 无法自动打开浏览器（" + error.getMessage() + "），请手动访问 " + url);
        }
    }

    private static void pauseForDiagnosis() {
        if (System.console() == null) {
            return;
        }
        System.out.print("按回车退出...");
        try {
            System.in.read();
        } catch (IOException ignored) {
            // best effort only: the diagnostic text is already on screen and in the log
        }
    }

    private Path logFile() {
        return logsDir.resolve("launcher.log");
    }

    private void truncateLauncherLog() {
        try {
            Files.createDirectories(logsDir);
            Files.writeString(logFile(), "", StandardCharsets.UTF_8);
        } catch (IOException ignored) {
            // logging must never break supervision
        }
    }

    private void log(String line) {
        String entry = LocalDateTime.now(ZoneOffset.systemDefault()) + " " + line;
        appendLog(entry);
        if (args != null && args.quiet) {
            return;
        }
        System.out.println("[launcher] " + line);
    }

    private void appendLog(String line) {
        try {
            Files.createDirectories(logsDir);
            Files.writeString(logFile(), line + System.lineSeparator(), StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException ignored) {
            // logging must never break supervision
        }
    }

    private static String indent(String text) {
        return text.lines().map(line -> "  | " + line).reduce("", (a, b) -> a + b + System.lineSeparator());
    }

    private static String tail(String text) {
        String[] lines = text.split("\r?\n");
        int from = Math.max(0, lines.length - 6);
        return String.join(" / ", List.of(lines).subList(from, lines.length));
    }

    private static String quote(String value) {
        return '"' + value.replace("\\", "\\\\").replace("\"", "\\\"") + '"';
    }

    private static String pad(String value) {
        return (value + "        ").substring(0, 8);
    }

    private static ProcessResult runProcess(List<String> command, Path cwd, String label) {
        return runProcess(command, cwd, label, Map.of());
    }

    /** Same, with extra environment (credentials must travel here, never in argv). */
    private static ProcessResult runProcess(List<String> command, Path cwd, String label,
            Map<String, String> extraEnv) {
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            if (cwd != null) {
                builder.directory(cwd.toFile());
            }
            if (!extraEnv.isEmpty()) {
                builder.environment().putAll(extraEnv);
            }
            builder.redirectErrorStream(true);
            Process process = builder.start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            int code = process.waitFor();
            return new ProcessResult(code, output);
        } catch (IOException error) {
            return new ProcessResult(-1, label + " failed: " + error.getMessage());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return new ProcessResult(-1, label + " interrupted");
        }
    }

    private static final class ProcessResult {
        final int exitCode;
        final String output;

        ProcessResult(int exitCode, String output) {
            this.exitCode = exitCode;
            this.output = output == null ? "" : output;
        }
    }

    private static final class ServiceSpec {
        final String name;
        final Path exe;
        final List<String> args;
        final Path cwd;
        final int port;
        final String healthPath;
        final Map<String, String> env;
        final long timeoutMs;
        int pid;
        long lastReadyMs;

        ServiceSpec(String name, Path exe, List<String> args, Path cwd, int port, String healthPath,
                Map<String, String> env, long timeoutMs) {
            this.name = name;
            this.exe = exe;
            this.args = args;
            this.cwd = cwd;
            this.port = port;
            this.healthPath = healthPath;
            this.env = env;
            this.timeoutMs = timeoutMs;
        }
    }

    private static final class ProcessRecord {
        String service = "";
        int pid;
        int port;
        String exe = "";
        String startedAt = "";
        long readyMs;

        ProcessRecord() {
        }

        ProcessRecord(String service, int pid, int port, String exe, String startedAt) {
            this.service = service;
            this.pid = pid;
            this.port = port;
            this.exe = exe;
            this.startedAt = startedAt;
        }
    }

    private static final class LauncherException extends RuntimeException {
        final String hint;
        /**
         * PLAN-0650: a security-policy refusal maps to exit 4 (user ruling Q-2) so a script can
         * tell "the secrets are wrong / the CP accepts factory defaults" from "a service did not
         * come up". Never set this for an ordinary startup failure.
         */
        final boolean security;

        LauncherException(String message, String hint) {
            this(message, hint, false);
        }

        LauncherException(String message, String hint, boolean security) {
            super(message);
            this.hint = hint;
            this.security = security;
        }
    }
}
