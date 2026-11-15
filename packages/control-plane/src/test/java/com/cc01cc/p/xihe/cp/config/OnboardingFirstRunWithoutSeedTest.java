package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-172（D-1532 ④ / 用户裁定 39D-2）**读数 1**：空库 + 开关关 ⇒ 管理员数 0，且 onboarding 判定接口
 * 报 {@code initialized:false}。
 *
 * <p>为什么这两条读数就是判据：{@code /onboarding} 页由 UI 侧
 * {@code router/index.ts:584-591} 决定 —— 它只读 {@code GET /api/v1/auth/bootstrap-status} 的
 * {@code initialized}（{@code AuthController:73-78} ⇒ {@code authService.hasAnyUser()}），为 false 就
 * 跳 {@code name: "onboarding"}（纯函数 {@code lib/authEntry.ts:19}，单测
 * {@code lib/__tests__/authEntry.spec.ts:16} 钉住）。所以在 CP 侧把「无账号」证出来，等于把
 * 「/onboarding 可达」证到它的上游判据；本类不碰 UI 代码。</p>
 *
 * <p>开关来源：{@code cp.bootstrap.seed-admin}（{@code application.properties} 里默认
 * {@code ${XIHE_SEED_ADMIN:false}}）。H2 测试档整体 opt-in 成 true（{@code application-h2.properties}），
 * 这里用 {@code @TestPropertySource} 显式压回 false —— 覆盖而非「跳过」：本类跑的就是产品默认形态。</p>
 */
@TestPropertySource(properties = {
        "XIHE_WORKSPACE_DOCKER_BACKEND=disabled",
        "cp.bootstrap.seed-admin=false"
})
class OnboardingFirstRunWithoutSeedTest extends AbstractH2Test {

    @Autowired
    private UserRepository users;

    @Test
    void anEmptyDatabaseWithTheSwitchOffHasNoAccountAndReportsUninitialized() {
        assertEquals(0L, users.count(),
                "a fresh installation must start with zero accounts when the switch is off");
        assertTrue(users.findByEmail("admin@xihe.local").isEmpty(),
                "the convenience admin must not be seeded while cp.bootstrap.seed-admin=false");

        String body = restTemplate.getForObject(url("/api/v1/auth/bootstrap-status"), String.class);
        assertTrue(body != null && body.contains("\"initialized\":false"),
                "bootstrap-status must report initialized=false so the UI enters /onboarding; got: " + body);
    }
}
