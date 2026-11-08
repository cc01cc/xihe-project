package com.cc01cc.p.xihe.cp.support;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-11 R-D 夹具（Lead 硬条件②）：证明复用桶的**类库**也带启动期写入——不是靠"测试碰巧绿"。
 *
 * <p>启动期写入来自 {@code config/DataSeeder}（{@code CommandLineRunner}）：admin 用户、
 * InstanceOwnership 指针、SUPER_ADMIN 实例绑定。它们只写默认库；R-D 用「默认库快照 + 类库从快照克隆」
 * 把这些写进每个类库（baseline 是每类新上下文各跑一次 DataSeeder）。三条断言逐项对应 Lead 的验收项。
 */
class ReuseSnapshotSeedFixtureTest extends AbstractReusableIntegrationTest {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void classDatabaseCarriesTheStartupSeedsFromTheSnapshot() {
        User admin = userRepository.findByEmail("admin@xihe.local")
                .orElseThrow(() -> new AssertionError("class database lacks the startup-seeded admin user"));
        UUID adminId = admin.getId();
        assertTrue(userRepository.findByEmail("admin@xihe.local").isPresent(),
                "admin@xihe.local must be present in every reused class database (StartupSeeds → snapshot)");

        Map<String, Object> ownership = jdbcTemplate.queryForMap(
                "select owner_user_id from instance_owner where id = 1");
        Object ownerId = ownership.get("owner_user_id");
        assertEquals(adminId, ownerId instanceof UUID ? ownerId : UUID.fromString(String.valueOf(ownerId)),
                "instance_owner.id=1 must point at the seeded admin (startup seed via snapshot)");

        Integer superAdminBindings = jdbcTemplate.queryForObject(
                "select count(*) from role_bindings rb join roles r on rb.role_id = r.id "
                        + "where r.name = 'SUPER_ADMIN' and rb.subject_type = 'user' "
                        + "and rb.subject_id = ? and rb.scope_type = 'instance'",
                Integer.class, adminId);
        assertEquals(1, superAdminBindings,
                "the seeded admin must carry exactly one instance-scoped SUPER_ADMIN binding");
    }
}
