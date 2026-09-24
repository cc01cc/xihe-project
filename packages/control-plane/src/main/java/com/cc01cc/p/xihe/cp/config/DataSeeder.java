package com.cc01cc.p.xihe.cp.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.UserRepository;

import java.security.SecureRandom;
import java.util.Base64;

@Component
public class DataSeeder implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(DataSeeder.class);
    private static final int PASSWORD_BYTES = 24;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String ADMIN_PASSWORD = seededPassword();

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final GrantDefaultService grantDefaultService;

    public DataSeeder(UserRepository userRepository, PasswordEncoder passwordEncoder,
                      GrantDefaultService grantDefaultService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.grantDefaultService = grantDefaultService;
    }

    static String seededAdminPassword() {
        return ADMIN_PASSWORD;
    }

    @Override
    @Transactional
    public void run(String... args) {
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

    private static String seededPassword() {
        String configured = System.getenv("XIHE_DEV_ADMIN_PASSWORD");
        return configured == null || configured.isBlank() ? generatePassword() : configured;
    }
}
