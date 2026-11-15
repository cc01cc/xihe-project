package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-172（D-1532 ④ / 用户裁定 39D-2）**读数 2**：空库 + 开关开 ⇒ 种子管理员存在且能登录。
 *
 * <p>这一条同时是**补救路径的实跑**：运维忘了开开关、库已经空着启动过一轮时，补救办法是
 * 「带着 XIHE_SEED_ADMIN=true 重启一次」（见 DEV-002 §首跑建号）。本用例做的就是这件事的
 * Spring 形态 —— 同一份 DataSeeder 代码、同一个 CommandLineRunner、真实 HTTP 登录，唯一区别是
 * 开关值由 @TestPropertySource 给（进程级 env / .env 文件层无法在 JVM 内注入，见卡面「证不了什么」）。</p>
 *
 * <p>幂等性由 DataSeeder 自身保证（findByEmail 存在就复用），所以「重启一次」不会造出第二个
 * admin；本类不重复钉那条，它属于既有行为。</p>
 */
@TestPropertySource(properties = {
        "XIHE_WORKSPACE_DOCKER_BACKEND=disabled",
        "cp.bootstrap.seed-admin=true"
})
class OnboardingSeededAdminLoginTest extends AbstractH2Test {

    @Autowired
    private UserRepository users;

    @Test
    void theSwitchSeedsAnAdminThatCanLogIn() {
        assertEquals(1L, users.count(),
                "cp.bootstrap.seed-admin=true on an empty database must create exactly one account");
        assertTrue(users.findByEmail("admin@xihe.local").isPresent(),
                "the seeded account must be admin@xihe.local");

        String bootstrap = restTemplate.getForObject(url("/api/v1/auth/bootstrap-status"), String.class);
        assertTrue(bootstrap != null && bootstrap.contains("\"initialized\":true"),
                "a seeded instance reports initialized=true (the onboarding path is spent); got: "
                        + bootstrap);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        Map<String, String> credentials = new LinkedHashMap<>();
        // LoginRequest.identifier 是双形态（邮箱含 @ 或 username），PLAN-0565 裁定 #7 把它从 email 改名而来。
        credentials.put("identifier", "admin@xihe.local");
        credentials.put("password", DataSeeder.seededAdminPassword());
        ResponseEntity<String> login = restTemplate.postForEntity(
                url("/api/v1/auth/login"), new HttpEntity<>(credentials, headers), String.class);

        assertEquals(200, login.getStatusCode().value(),
                "the recovery-path account must actually be usable; body: " + login.getBody());
        assertNotNull(login.getBody());
        assertTrue(login.getBody().contains("\"accessToken\""),
                "login must hand out tokens; body: " + login.getBody());
    }
}
