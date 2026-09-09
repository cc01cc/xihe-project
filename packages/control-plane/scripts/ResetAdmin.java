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
 * 免重启直接 upsert users 表密码：
 *   - 缺省：随机生成 24 字节 base64url 密码（>=12 位硬约束）并打印
 *   - --password <pw>：按指定值设置（<12 位仅警告不阻止）
 *   - 账号不存在则以 ADMIN 角色创建；绝不删除任何数据行
 *
 * 用法（经 scripts/reset-admin.ps1 包装）：
 *   java ResetAdmin.java [--email admin@xihe.local] [--password <pw>] [--url <jdbcUrl>]
 */
public class ResetAdmin {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int PASSWORD_BYTES = 24;

    public static void main(String[] args) throws Exception {
        String email = "admin@xihe.local";
        String password = null;
        String url = System.getenv().getOrDefault(
                "XIHE_CP_DATASOURCE_URL", "jdbc:postgresql://localhost:12634/xihe");
        String user = System.getenv().getOrDefault("XIHE_CP_DATASOURCE_USERNAME", "xihe");
        String dbPassword = System.getenv().getOrDefault("XIHE_CP_DATASOURCE_PASSWORD", "");

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--email" -> email = requireValue(args, ++i, "--email");
                case "--password" -> password = requireValue(args, ++i, "--password");
                case "--url" -> url = requireValue(args, ++i, "--url");
                case "--user" -> user = requireValue(args, ++i, "--user");
                default -> {
                    System.err.println("[reset-admin] 未知参数: " + args[i]);
                    System.exit(2);
                }
            }
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

            if (id != null) {
                try (PreparedStatement ps = conn.prepareStatement(
                        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")) {
                    ps.setString(1, hash);
                    ps.setTimestamp(2, now);
                    // users.id 是原生 UUID 列（PLAN-280），字符串绑定会报 uuid = character varying。
                    ps.setObject(3, UUID.fromString(id));
                    ps.executeUpdate();
                }
                System.out.println("[reset-admin] 已更新 " + email + " 密码（免重启，可直接登录）");
            } else {
                UUID newId = UUID.randomUUID();
                try (PreparedStatement ps = conn.prepareStatement(
                        "INSERT INTO users (id, email, password_hash, role, name, created_at, updated_at) "
                                + "VALUES (?, ?, ?, 'ADMIN', ?, ?, ?)")) {
                    ps.setObject(1, newId);
                    ps.setString(2, email);
                    ps.setString(3, hash);
                    ps.setString(4, "Admin");
                    ps.setTimestamp(5, now);
                    ps.setTimestamp(6, now);
                    ps.executeUpdate();
                }
                System.out.println("[reset-admin] 已创建 " + email + "（ADMIN，免重启，可直接登录）");
            }
        }

        if (generated) {
            System.out.println("[reset-admin] 新随机密码:");
            System.out.println("  " + password);
        }
    }

    private static String requireValue(String[] args, int idx, String flag) {
        if (idx >= args.length) {
            System.err.println("[reset-admin] " + flag + " 缺少值");
            System.exit(2);
        }
        return args[idx];
    }
}
