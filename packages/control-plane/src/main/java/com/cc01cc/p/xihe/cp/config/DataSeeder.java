package com.cc01cc.p.xihe.cp.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.OrgUnitMemberRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.UUID;

@Component
public class DataSeeder implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(DataSeeder.class);
    private static final int PASSWORD_BYTES = 24;
    private static final SecureRandom RANDOM = new SecureRandom();

    /**
     * PLAN-0773 M1-6 (task-260): the root unit seeded by {@code V167__plan0773_org_unit_seed_root.sql}.
     * The id is duplicated here on purpose and it must stay equal to the migration's literal: the
     * migration cannot write the membership (no user row exists at migration time), and this class
     * cannot guess a unit id (a "the root" query is ambiguous once a second root exists). One fixed
     * value is the only thing both halves can agree on; {@code V167}'s header explains the choice.
     */
    static final UUID ROOT_ORG_UNIT_ID = UUID.fromString("00000000-0000-4000-8000-0000000000e1");

    private static final String HUMAN = "human";
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
    private final com.cc01cc.p.xihe.cp.service.InstanceOwnershipService instanceOwnershipService;
    private final com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog systemAccessRoleCatalog;
    private final OrgUnitReadRepository orgUnits;
    private final OrgUnitMemberRepository orgUnitMembers;
    /**
     * Whether the org-unit seed can run at all. {@code org_units} exists only on PostgreSQL: it is
     * an ltree table with no JPA entity, so the H2 profile (schema built from the entities,
     * Flyway disabled) does not have it. Asking before querying keeps a PostgreSQL-only seed from
     * turning every H2 test into a context-startup failure.
     */
    private final boolean postgres;

    public DataSeeder(UserRepository userRepository, PasswordEncoder passwordEncoder,
                      GrantDefaultService grantDefaultService,
                      com.cc01cc.p.xihe.cp.service.InstanceOwnershipService instanceOwnershipService,
                      com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog systemAccessRoleCatalog,
                      OrgUnitReadRepository orgUnits, OrgUnitMemberRepository orgUnitMembers,
                      @Value("${spring.datasource.url:}") String datasourceUrl) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.grantDefaultService = grantDefaultService;
        this.instanceOwnershipService = instanceOwnershipService;
        this.systemAccessRoleCatalog = systemAccessRoleCatalog;
        this.orgUnits = orgUnits;
        this.orgUnitMembers = orgUnitMembers;
        this.postgres = datasourceUrl != null
                && (datasourceUrl.startsWith("jdbc:postgresql:")
                || datasourceUrl.startsWith("jdbc:tc:postgresql:"));
    }

    static String seededAdminPassword() {
        return ADMIN_PASSWORD;
    }

    @Override
    @Transactional
    public void run(String... args) {
        // PLAN-0610 T1.2: the built-in access-role catalog. V87 seeds it on PostgreSQL; this call
        // makes the same catalog present on a schema built from the entities (H2 profile, Flyway
        // disabled) and is a no-op on an already migrated database.
        systemAccessRoleCatalog.ensureSeeded();
        // PLAN-0758: the retired local-mode early return is gone — a fresh instance
        // always gets the seeded dev admin, so the onboarding path starts from it.
        User admin = userRepository.findByEmail("admin@xihe.local").orElse(null);
        if (admin == null) {
            admin = new User("admin@xihe.local", passwordEncoder.encode(ADMIN_PASSWORD), "Admin");
            admin = userRepository.save(admin);
            log.info("Seeded default admin user: admin@xihe.local");
        }
        // PLAN-0580: V85's backfill runs before any account exists on a fresh
        // database, so the seeded admin must claim ownership afterwards. The call
        // is idempotent and never overwrites a pointer moved through the API.
        //
        // Order is frozen by spec `authorization.md` §4「实例级写互斥」: the lock
        // order MUST be `instance_owner` -> target `users` row. `ensureUserDefault`
        // locks the `users` row first, so claiming ownership afterwards would take
        // the two locks in the opposite order and form a deadlock pair with
        // the binding write paths, which follow the frozen order. Swapping is
        // safe: `ensureAssigned` only needs the persisted admin row, never the
        // default grant.
        instanceOwnershipService.ensureAssigned(admin, admin.getId().toString());
        // PLAN-0610 T1.9: a fresh instance starts with a SUPER_ADMIN binding (invariant I1), not a
        // plain ADMIN. Idempotent, and it materializes the role atoms in the same transaction.
        grantDefaultService.ensureInstanceSuperAdmin(admin);
        // PLAN-0773 M1-6 (task-260): the second half of the org-unit seed. V167 creates the root
        // unit; this places the seeded admin in it. Both halves are seeds, and a seed is worth
        // nothing if the subject is missing (an empty tree 404s the page that needs it) or if the
        // placement is not re-runnable (a restart must not duplicate or move it).
        placeSeedAdminInRootUnit(admin);
    }

    /**
     * M1-6: hang the seeded admin on the root unit. Idempotent because
     * {@link OrgUnitMemberRepository#place} is an upsert on {@code (member_kind, member_id)} --
     * a restart rewrites the same row to the same value instead of inserting a second one.
     *
     * <p><b>Why not in the migration.</b> {@code org_unit_members.member_id} references a user that
     * has to exist first, and no migration in this repository has ever inserted a user
     * ({@code User.id} is {@code GenerationType.UUID}, i.e. minted at runtime). A migration that
     * invented an account would be inventing a subject, not seeding one. V85 documents the same
     * split for instance ownership: the schema half runs before any account exists, the account
     * half runs here.</p>
     *
     * <p><b>Why the existence check.</b> {@code org_unit_members.org_unit_id} has a FK to
     * {@code org_units} (V164). If the root row were ever removed by hand, an unconditional place
     * would fail the whole startup transaction on a FK violation and take the admin seed with it.
     * A missing root means "this database was not seeded", which is reported, not crashed on.</p>
     *
     * <p><b>Consequence worth knowing</b> (it is a rule of {@code OrgUnitAccess}, not a side
     * effect invented here): once the admin has a membership row, its
     * scope becomes that unit's subtree instead of the whole tree, so {@code create(name, null)} --
     * which requires {@code scope.wholeTree()} -- is no longer available to it. Units are then
     * created <i>under</i> the root, which is what the tree is for; the instance-level atom still
     * lets a non-member create roots.</p>
     */
    private void placeSeedAdminInRootUnit(User admin) {
        if (!postgres) {
            // H2 profile: org_units is an ltree table with no JPA entity, so it is absent here.
            return;
        }
        if (orgUnits.findUnit(ROOT_ORG_UNIT_ID).isEmpty()) {
            log.warn("Org-unit root seed missing: V167 did not run on this database,"
                    + " so admin@xihe.local stays unplaced (org members page will be empty)");
            return;
        }
        orgUnitMembers.place(HUMAN, admin.getId(), ROOT_ORG_UNIT_ID);
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

