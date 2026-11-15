package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * task-172（D-1532 ④）：把**发布形态的默认值**钉在配置行上。
 *
 * <p>为什么需要单独一条：H2 / Testcontainers 两个测试档都把开关 opt-in 成 true（它们的夹具假设
 * 启动即有 admin），所以在测试里「不传属性」并不等于「生产默认」。产品默认只写在
 * src/main/resources/application.properties 这一行里 —— 本类读的就是那条真身。它挡两类回归：
 * ① 有人把默认翻成 true（全新安装又会被 seed 顶掉 /onboarding）；② 有人删掉这行、把默认退回
 * {@code @Value} 里的字面量（那会让「默认值」在两处各写一遍，改一处就静默不一致）。</p>
 *
 * <p>本类只证明**配置行的内容**，不证明 Spring 的占位解析；解析行为由
 * {@link OnboardingFirstRunWithoutSeedTest}（压回 false）与
 * {@link OnboardingSeededAdminLoginTest}（打开 true）两个真启动用例分别覆盖。</p>
 */
class FirstRunSeedShippedDefaultTest {

    @Test
    void theShippedDefaultIsOffAndDeclaredExplicitly() throws IOException {
        Properties shipped = new Properties();
        try (InputStream in = getClass().getClassLoader()
                .getResourceAsStream("application.properties")) {
            assertNotNull(in, "application.properties must be on the test classpath");
            shipped.load(in);
        }

        String declared = shipped.getProperty("cp.bootstrap.seed-admin");
        assertNotNull(declared, "cp.bootstrap.seed-admin must be declared in application.properties,"
                + " not left to an @Value literal");
        assertEquals("${XIHE_SEED_ADMIN:false}", declared.trim(),
                "a fresh installation must not be seeded: the default has to stay false");
    }
}
