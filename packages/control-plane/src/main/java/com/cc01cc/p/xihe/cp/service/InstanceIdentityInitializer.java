package com.cc01cc.p.xihe.cp.service;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * D-935 / PLAN-0767 M1: seeds the deployment identity after the context (and therefore Flyway) is
 * ready, but before the application is considered started. Deliberately an {@link ApplicationRunner}
 * instead of {@code @PostConstruct}: bean init order could run before the migration that creates
 * {@code instance_identity}, while a runner failure makes {@code SpringApplication.run} exit
 * non-zero — exactly the fail-fast contract of {@code instance_identity_mismatch}.
 */
@Component
public class InstanceIdentityInitializer implements ApplicationRunner {

    private final InstanceIdentityService identity;
    private final Environment environment;

    public InstanceIdentityInitializer(InstanceIdentityService identity, Environment environment) {
        this.identity = identity;
        this.environment = environment;
    }

    @Override
    public void run(ApplicationArguments args) {
        String configured = environment.getProperty("XIHE_DEPLOYMENT_ID");
        try {
            identity.ensureSeeded(configured);
        } catch (org.springframework.dao.DataIntegrityViolationException race) {
            // Concurrent first boot (blue/green, two containers): both saw an empty table and the
            // loser hit pk_instance_identity. The whole seeding transaction rolled back, so the
            // retry is a fresh transaction that re-reads the winner's row instead of assuming this
            // process inserted it. Any real failure (env conflict, invalid value) is not a data
            // integrity exception and still fails fast.
            identity.ensureSeeded(configured);
        }
    }
}
