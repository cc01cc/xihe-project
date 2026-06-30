package com.cc01cc.p.xihe.cp.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.UserRepository;

@Component
public class DataSeeder implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(DataSeeder.class);

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;

    public DataSeeder(UserRepository userRepository, PasswordEncoder passwordEncoder) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
    }

    @Override
    public void run(String... args) {
        if (userRepository.findByEmail("admin@xihe.local").isEmpty()) {
            User admin = new User("admin@xihe.local", passwordEncoder.encode("admin123"), com.cc01cc.p.xihe.cp.entity.UserRole.ADMIN, "Admin");
            userRepository.save(admin);
            log.info("Seeded default admin user: admin@xihe.local");
        }
    }
}
