package com.cc01cc.p.xihe.cp.audit;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.Session;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-542 判据①②④：真库读数，不是日志读数。
 *
 * <p>口径（Lead 2026-11-14 给定）：<b>表只增 1 行 / 一次会话</b>，不用「不翻倍」这种模糊说法。
 * 快照行比全表均值宽属可接受（基线 p50 224 B / max 1736 B）。</p>
 */
class SessionSnapshotAuditIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private SessionSnapshotAudit audit;

    private int rows() {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = ?", Integer.class,
                SessionSnapshotAudit.ACTION);
        return count == null ? 0 : count;
    }

    /** ① 恰好一条 ② enforcement=none 可查 ④ 一次冻结只增 1 行。 */
    @Test
    void oneRowPerFrozenSessionWithEnforcementNoneQueryable() {
        int before = rows();
        // audit_logs.user_id 是 UUID 且有外键到 users ⇒ 夹具必须先落一个真用户行（类级克隆库，随类销毁）。
        UUID userId = UUID.randomUUID();
        jdbc.update("INSERT INTO users (id, email, password_hash, username) VALUES (?, ?, ?, ?)",
                userId, userId + "@task542.test", "x", "task542-" + userId.toString().substring(0, 8));
        // 无工作区会话（D-686 合法形态）：audit_logs 对 workspaces 也有外键，且这正好覆盖
        // 「根数量查不到 ⇒ 照实记 0」那条口径（不拿默认值填空）。
        Session session = new Session(null, userId.toString(), "t");
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(null);

        audit.frozen(session);

        assertEquals(0, audit.failureCount(), "fail-open 吞掉的写失败必须在这里露出来（计数=0 才说明真写成功）");
        assertEquals(before + 1, rows(), "一次冻结只增 1 行（不是 0 行、也不是每次访问一行）");
        List<String> details = jdbc.queryForList(
                "SELECT details FROM audit_logs WHERE action = ? AND resource_id = ?", String.class,
                SessionSnapshotAudit.ACTION, session.getId().toString());
        assertEquals(1, details.size(), "该会话恰好一条快照审计");
        String detail = details.get(0);
        assertNotNull(detail);
        assertTrue(detail.contains("enforcement=none"), "enforcement=none 必须可查");
        assertTrue(detail.contains("roots=0"), "无工作区时根数量照实记 0，不填空值");
        assertTrue(detail.contains("executionMode=unknown"), "查不到执行模式就记 unknown");
        assertTrue(detail.contains(SessionSnapshotAudit.SCOPE_GAP_NOTE), "缺口声明必须在记录里");
        Runnable noop = () -> { };
        noop.run();
    }
}
