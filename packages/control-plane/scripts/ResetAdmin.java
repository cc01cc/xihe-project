import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

/**
 * PLAN-229: XH reset-admin — dev 密码重置 CLI（对应 EW reset-admin.ts, PLAN-138 M4.5）。
 *
 * **只改密码**（UPDATE），不再自建账号：旧 INSERT 分支写 `users.role`，而 V89（PLAN-0610 W4b）
 * 已 `DROP COLUMN role` ⇒ 在任何已迁移库上必然 SQL 报错；继续保留等于给运维假成功（BL-523）。
 * 用户行不存在时显式失败（exit 3）并指向 `mise run dev:reset` 或重启 CP 由 DataSeeder 建行。
 *
 * 密码输入优先级（BL-523 起）：**stdin > env `XIHE_RESET_ADMIN_PASSWORD` > `--password`**；
 * 最后者保留但打印 deprecation WARN —— 明文 argv 会进进程表与 shell 历史。
 *   - stdin：`--password-stdin` 显式阻塞读；否则仅在「非交互终端且有数据可读」时自动识别
 *     （不阻塞是硬要求：没有管道时本工具不能把 CLI 卡住）。
 *   - 三路都没有 ⇒ 随机生成 24 字节 base64url（>=12 位硬约束）并打印。
 *
 * 用法（经 scripts/reset-admin.ps1 包装）：
 *   java ResetAdmin.java [--email admin@xihe.local] [--password <pw>] [--url <jdbcUrl>] [--dry-run]
 *   echo <pw> | java ResetAdmin.java [--password-stdin] …
 *
 * 目标库解析顺序：--url > XIHE_CP_DATASOURCE_URL > localhost:$XIHE_PG_PORT/$POSTGRES_DB
 * （默认 12634/xihe_1，与 PLAN-0533 的 `xihe_<n>` 命名一致；启动时会打印实际目标，
 * 避免在旧库上改密码却以为改的是运行库）。
 */
public class ResetAdmin {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int PASSWORD_BYTES = 24;
    /** 非 argv 输入通道（BL-523）：优先级高于已废弃的 `--password`。 */
    private static final String PASSWORD_ENV = "XIHE_RESET_ADMIN_PASSWORD";
    /** 用户行不存在（本工具只改密码，不再自建；BL-523）。区别于 2 = 用法错误。 */
    private static final int EXIT_USER_MISSING = 3;

    public static void main(String[] args) throws Exception {
        String email = "admin@xihe.local";
        String argvPassword = null;
        String url = System.getenv().getOrDefault(
                "XIHE_CP_DATASOURCE_URL", defaultJdbcUrl());
        String user = System.getenv().getOrDefault("XIHE_CP_DATASOURCE_USERNAME", "xihe");
        String dbPassword = System.getenv().getOrDefault("XIHE_CP_DATASOURCE_PASSWORD", "");
        boolean dryRun = false;
        boolean passwordStdin = false;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--email" -> email = requireValue(args, ++i, "--email");
                case "--password" -> argvPassword = requireValue(args, ++i, "--password");
                case "--url" -> url = requireValue(args, ++i, "--url");
                case "--user" -> user = requireValue(args, ++i, "--user");
                case "--dry-run" -> dryRun = true;
                case "--password-stdin" -> passwordStdin = true;
                default -> {
                    System.err.println("[reset-admin] 未知参数: " + args[i]);
                    System.exit(2);
                }
            }
        }

        System.out.println("[reset-admin] target = " + url);

        // BL-523: stdin > env > --password（后者已废弃）。哪一路命中都要可解释，但不回显值。
        String password = null;
        String source;
        String fromStdin = readPasswordFromStdin(passwordStdin);
        String fromEnv = blankToNull(System.getenv(PASSWORD_ENV));
        if (fromStdin != null) {
            password = fromStdin;
            source = "stdin";
            if (fromEnv != null) {
                System.err.println("[reset-admin] 提示: stdin 与 env " + PASSWORD_ENV + " 同时存在，取 stdin");
            }
            if (argvPassword != null) {
                warnDeprecatedArgv();
            }
        } else if (fromEnv != null) {
            password = fromEnv;
            source = "env";
            if (argvPassword != null) {
                warnDeprecatedArgv();
            }
        } else if (argvPassword != null) {
            password = argvPassword;
            source = "argv";
            warnDeprecatedArgv();
        } else {
            source = "generated";
        }

        if (dryRun) {
            // 只报来源，不连库、不回显值 —— 用于核对三条输入通道是否按预期生效。
            System.out.println("[reset-admin] dry-run: password-source = " + source
                    + (password == null ? "（将生成 24 字节随机密码）" : "（length=" + password.length() + "，值不打印）"));
            return;
        }

        boolean generated = password == null;
        if (generated) {
            byte[] bytes = new byte[PASSWORD_BYTES];
            RANDOM.nextBytes(bytes);
            password = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        } else if (password.length() < 12) {
            System.err.println("[reset-admin] 警告: 指定密码不足 12 位（workspace 约定密码须随机 12+ 位）");
        }

        String hash = new BCryptPasswordEncoder().encode(password);
        Timestamp now = Timestamp.from(Instant.now());

        try (Connection conn = DriverManager.getConnection(url, user, dbPassword)) {
            String id = null;
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT id FROM users WHERE email = ?")) {
                ps.setString(1, email);
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        id = rs.getString("id");
                    }
                }
            }

            if (id == null) {
                // BL-523：不再 INSERT 半可用账号（缺 instance owner / SUPER_ADMIN 绑定，且旧 SQL 写已删列）。
                System.err.println("[reset-admin] 用户行不存在: " + email + " —— 本工具只改密码，不再自建账号。");
                System.err.println("[reset-admin] 原因: 旧 INSERT 分支写 users.role，而 V89（PLAN-0610 W4b）已删该列"
                        + "（BL-523）；自建行还会缺 instance owner / SUPER_ADMIN 绑定。");
                System.err.println("[reset-admin] 处理: 运行 `mise run dev:reset` 重置开发库，或重启该栈让 CP 的"
                        + " DataSeeder 建 admin 行后重跑本命令。");
                System.exit(EXIT_USER_MISSING);
            }

            try (PreparedStatement ps = conn.prepareStatement(
                    "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")) {
                ps.setString(1, hash);
                ps.setTimestamp(2, now);
                // users.id 是原生 UUID 列（PLAN-280），字符串绑定会报 uuid = character varying。
                ps.setObject(3, UUID.fromString(id));
                ps.executeUpdate();
            }
            System.out.println("[reset-admin] 已更新 " + email + " 密码（免重启，可直接登录；source=" + source + "）");
        }

        if (generated) {
            System.out.println("[reset-admin] 新随机密码:");
            System.out.println("  " + password);
        }
    }

    /** `--password` 已废弃：明文 argv 会进进程表与 shell 历史（BL-523）。 */
    private static void warnDeprecatedArgv() {
        System.err.println("[reset-admin] 警告: --password 走明文 argv（进进程表 / shell 历史），已废弃；"
                + "改用 stdin（`echo <pw> | …`）或 env " + PASSWORD_ENV);
    }

    /**
     * 读 stdin 上的密码：显式 `--password-stdin` 时阻塞读到 EOF；否则仅在「非交互终端且已有数据
     * 可读」时自动识别 —— 没有管道时必须立刻返回，绝不能把 CLI 卡在 stdin 上。
     */
    private static String readPasswordFromStdin(boolean explicit) {
        try {
            if (!explicit && System.console() != null) {
                return null;
            }
            if (!explicit && System.in.available() <= 0) {
                return null;
            }
            byte[] bytes = System.in.readAllBytes();
            return blankToNull(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
        } catch (java.io.IOException e) {
            System.err.println("[reset-admin] 警告: 读取 stdin 失败（" + e.getMessage() + "），继续按 env/argv 解析");
            return null;
        }
    }

    /** 去首尾空白；空白/空串一律视为「未提供」（管道 tail 的换行、`.env` 的空占位都走这条）。 */
    private static String blankToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static String requireValue(String[] args, int idx, String flag) {
        if (idx >= args.length) {
            System.err.println("[reset-admin] " + flag + " 缺少值");
            System.exit(2);
        }
        return args[idx];
    }

    /**
     * Default target, following PLAN-0533's per-stack database naming (xihe_1, xihe_2, ...).
     * The pre-0533 default was the single `xihe` database, which silently wrote the admin
     * password to a database the running services no longer read.
     */
    private static String defaultJdbcUrl() {
        return "jdbc:postgresql://localhost:" + envOr("XIHE_PG_PORT", "12634") + "/" + envOr("POSTGRES_DB", "xihe_1");
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
