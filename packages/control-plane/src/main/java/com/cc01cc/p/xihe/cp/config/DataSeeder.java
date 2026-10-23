package com.cc01cc.p.xihe.cp.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.auth.LocalModeService;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.UserRepository;

import java.security.SecureRandom;
import java.util.Base64;

@Component
public class DataSeeder implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(DataSeeder.class);
    private static final int PASSWORD_BYTES = 24;
    private static final SecureRandom RANDOM = new SecureRandom();
    // PLAN-0547: three-tier resolution (OS env > system property > random). The system
    // property tier makes the DotenvLoader .env chain reachable — DotenvLoader.load runs
    // first in CpApplication.main(), before this class initializes inside Spring, and
    // writes .env* file values into system properties (never over OS env).
    private static final String ADMIN_PASSWORD =
            resolveSeededPassword(
                    () -> System.getenv("XIHE_DEV_ADMIN_PASSWORD"),
                    () -> System.getProperty("XIHE_DEV_ADMIN_PASSWORD"),
                    DataSeeder::generatePassword);

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final GrantDefaultService grantDefaultService;
    private final LocalModeService localModeService;

    public DataSeeder(UserRepository userRepository, PasswordEncoder passwordEncoder,
                      GrantDefaultService grantDefaultService, LocalModeService localModeService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.grantDefaultService = grantDefaultService;
        this.localModeService = localModeService;
    }

    static String seededAdminPassword() {
        return ADMIN_PASSWORD;
    }

    @Override
    @Transactional
    public void run(String... args) {
        // PLAN-0526: local mode is a fresh single-user bootstrap — do not seed the
        // default admin, so the instance starts with zero users and can onboard.
        if (localModeService.enabled()) {
            log.info("Local mode enabled: skipping default admin seed");
            return;
        }
        User admin = userRepository.findByEmail("admin@xihe.local").orElse(null);
        if (admin == null) {
            admin = new User("admin@xihe.local", passwordEncoder.encode(ADMIN_PASSWORD),
                    com.cc01cc.p.xihe.cp.entity.UserRole.ADMIN, "Admin");
            admin = userRepository.save(admin);
            log.info("Seeded default admin user: admin@xihe.local");
        }
        grantDefaultService.ensureUserDefault(admin);
    }

    private static String generatePassword() {
        byte[] bytes = new byte[PASSWORD_BYTES];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /**
     * PLAN-0547: package-visible pure resolver so tests can pin the priority contract
     * (OS env > system property > random) without touching global state.
     */
    static String resolveSeededPassword(java.util.function.Supplier<String> env,
                                        java.util.function.Supplier<String> property,
                                        java.util.function.Supplier<String> random) {
        String configured = env.get();
        if (configured == null || configured.isBlank()) {
            configured = property.get();
        }
        return configured == null || configured.isBlank() ? random.get() : configured;
    }
}
