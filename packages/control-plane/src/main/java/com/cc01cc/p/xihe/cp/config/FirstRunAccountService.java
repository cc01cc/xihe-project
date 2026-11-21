package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.auth.NameFormat;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * D-1535 (task-5, formerly task-149): the one-time disclosure of the first-run administrator
 * credential, and its in-place rewrite.
 *
 * <p><b>Carrier is process memory, on purpose.</b> A generated password belongs to the boot that
 * minted it; a restart mints a new one and the old value is unknowable to the new process (the row
 * keeps its hash, so {@link #disclose()} refuses instead of handing out a value that cannot log in).
 * Persisting the plaintext would add a second copy of the secret to backups and replication for a
 * window that lasts one boot — see the rejected options in
 * {@code internal/A03-xihe/evidence/2026-11-21-first-run-secret-handoff/README.md} §5.</p>
 *
 * <p><b>Three paths must be told apart</b> (the same split {@link DataSeeder} documents):</p>
 * <ul>
 *   <li><b>A</b> {@code cp.bootstrap.seed-admin=false} (product default): no seeded account, so this
 *       face answers 403 — the first account is created by {@code /onboarding} with a password the
 *       user just chose, and there is nothing to disclose;</li>
 *   <li><b>B</b> seeded + no {@code XIHE_DEV_ADMIN_PASSWORD}: the value was generated for this boot
 *       and is returned exactly once;</li>
 *   <li><b>C</b> seeded + configured password: an operator secret. The response carries
 *       {@code state=operator-provided} and {@code secret=null}; the value is never echoed
 *       (D-1535 ②). Rotation goes through the existing admin reset face.</li>
 * </ul>
 *
 * <p><b>Why the hash is checked.</b> {@code DataSeeder} generates a value even when the row already
 * exists, and in that case the generated value was never written to the row. Comparing
 * {@code passwordEncoder.matches(generated, storedHash)} is the decisive test for "this boot's value
 * is the live credential": it needs no extra bookkeeping and it fails closed on the restart case.
 * The check is a bcrypt comparison of two in-process strings; nothing about either value is logged.</p>
 *
 * <p><b>Single-shot per boot.</b> The phase latch is per process: OPEN → DISCLOSED (first successful
 * disclosure) or → REWRITTEN. A second disclosure answers 410
 * {@code FIRST_RUN_ACCOUNT_ALREADY_DISCLOSED} and a second rewrite answers 409
 * {@code FIRST_RUN_ACCOUNT_ALREADY_REWRITTEN}; both are checked before any row is read, so the
 * "already initialized" marker cannot be turned into an existence oracle.</p>
 */
@Component
public class FirstRunAccountService {

    private static final Logger log = LoggerFactory.getLogger(FirstRunAccountService.class);

    static final String SEEDED_ADMIN_EMAIL = "admin@xihe.local";
    static final String STATE_GENERATED = "generated-secret";
    static final String STATE_OPERATOR = "operator-provided";
    public static final String CODE_NOT_AVAILABLE = "FIRST_RUN_ACCOUNT_NOT_AVAILABLE";
    static final String CODE_ALREADY_DISCLOSED = "FIRST_RUN_ACCOUNT_ALREADY_DISCLOSED";
    static final String CODE_ALREADY_REWRITTEN = "FIRST_RUN_ACCOUNT_ALREADY_REWRITTEN";

    private static final String PASSWORD_ENV_KEY = "XIHE_DEV_ADMIN_PASSWORD";
    /** Same bounds as registration ({@code RegisterRequest.password}: {@code @Size(min = 8, max = 128)}). */
    private static final int PASSWORD_MIN = 8;
    private static final int PASSWORD_MAX = 128;

    private enum Phase { OPEN, DISCLOSED, REWRITTEN }

    private final UserRepository users;
    private final PasswordEncoder passwordEncoder;
    private final boolean seedAdmin;
    private final Function<String, String> env;
    private final Supplier<String> property;
    private final AtomicReference<Phase> phase = new AtomicReference<>(Phase.OPEN);
    private final Instant issuedAt = Instant.now();

    /**
     * Spring's entry point. The {@code @Autowired} is required because the env/property seam below adds
     * a second constructor: with more than one candidate, Spring falls back to "no-arg or explicit
     * annotation" and a class with two plain constructors fails to instantiate. Same shape as
     * {@code LoginAttemptService}.
     */
    @Autowired
    public FirstRunAccountService(UserRepository users, PasswordEncoder passwordEncoder,
                                  @Value("${cp.bootstrap.seed-admin:false}") boolean seedAdmin) {
        this(users, passwordEncoder, seedAdmin, FirstRunLocalAccess::envValue,
                () -> System.getProperty(PASSWORD_ENV_KEY));
    }

    /** Test seam: the two suppliers are the same pair {@link DataSeeder#isPasswordConfigured} consumes. */
    FirstRunAccountService(UserRepository users, PasswordEncoder passwordEncoder, boolean seedAdmin,
                           Function<String, String> env, Supplier<String> property) {
        this.users = users;
        this.passwordEncoder = passwordEncoder;
        this.seedAdmin = seedAdmin;
        this.env = env;
        this.property = property;
    }

    /**
     * First call returns the payload; every later call answers 410 with no secret. Synchronized so two
     * concurrent requests cannot both observe {@code OPEN} and both get a 200 (the loser answers 410).
     */
    @Transactional(readOnly = true)
    public synchronized Map<String, Object> disclose() {
        if (phase.get() != Phase.OPEN) {
            throw alreadyDisclosed();
        }
        User admin = requireSingleSeededAccount();
        Map<String, Object> body = new LinkedHashMap<>();
        Map<String, Object> account = new LinkedHashMap<>();
        account.put("email", admin.getEmail());
        account.put("username", admin.getUsername());
        body.put("account", account);
        if (DataSeeder.isPasswordConfigured(() -> env.apply(PASSWORD_ENV_KEY), property)) {
            body.put("state", STATE_OPERATOR);
            body.put("secret", null);
            body.put("source", "env");
        } else {
            String generated = DataSeeder.seededAdminPassword();
            if (!passwordEncoder.matches(generated, admin.getPasswordHash())) {
                // A restart (or a manual reset) already moved the stored credential away from this
                // boot's generated value. Printing it would be a false credential.
                throw notAvailable("this boot's generated password is not the stored credential;"
                        + " recover the account with `mise run reset-admin`");
            }
            Map<String, Object> secret = new LinkedHashMap<>();
            secret.put("value", generated);
            secret.put("issuedAt", issuedAt);
            body.put("state", STATE_GENERATED);
            body.put("secret", secret);
            body.put("source", null);
        }
        phase.set(Phase.DISCLOSED);
        log.info("[LIFECYCLE] service=cp event=first_run_account_disclosed target={} state={}",
                admin.getId(), body.get("state"));
        return body;
    }

    /**
     * Rewrites the seeded account in place. The old password stops working because only the hash is
     * replaced, and both token epochs are bumped in the same transaction — the same dual-revocation
     * primitive {@code UserAdminService.resetPassword} uses, so a token minted for the disclosed
     * credential dies on its next request instead of living out its TTL.
     */
    @Transactional
    public synchronized Map<String, Object> rewrite(String username, String rawPassword) {
        if (phase.get() == Phase.REWRITTEN) {
            throw new CpApiException(HttpStatus.CONFLICT, CODE_ALREADY_REWRITTEN,
                    "The first-run account was already rewritten for this boot");
        }
        User admin = requireSingleSeededAccount();
        if (rawPassword == null || rawPassword.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "password is required");
        }
        if (rawPassword.length() < PASSWORD_MIN || rawPassword.length() > PASSWORD_MAX) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "password must be between " + PASSWORD_MIN + " and " + PASSWORD_MAX
                            + " characters");
        }
        String resolvedUsername = admin.getUsername();
        if (username != null && !username.isBlank()) {
            resolvedUsername = NameFormat.require(username, "username", NameFormat.USERNAME_MAX_LENGTH);
            if (!resolvedUsername.equals(admin.getUsername())
                    && users.existsByUsername(resolvedUsername)) {
                throw new CpApiException(HttpStatus.CONFLICT, "USERNAME_TAKEN",
                        "Username already taken");
            }
        }
        admin.setUsername(resolvedUsername);
        admin.setPasswordHash(passwordEncoder.encode(rawPassword));
        admin.bumpTokenVersion();
        admin.bumpSessionVersion();
        User saved = users.save(admin);
        phase.set(Phase.REWRITTEN);
        log.info("[LIFECYCLE] service=cp event=first_run_account_rewritten target={}", saved.getId());
        Map<String, Object> account = new LinkedHashMap<>();
        account.put("email", saved.getEmail());
        account.put("username", saved.getUsername());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("account", account);
        body.put("secretRevoked", true);
        return body;
    }

    /**
     * The single-user-count gate (D-1535 ③): disclosure is only meaningful while the seeded admin is
     * the instance's only account. A second account means the first run is over.
     */
    private User requireSingleSeededAccount() {
        if (!seedAdmin) {
            throw notAvailable("cp.bootstrap.seed-admin is off; the first account is created through"
                    + " /onboarding and there is no generated credential to disclose");
        }
        long accounts = users.count();
        if (accounts != 1) {
            throw notAvailable("the instance holds " + accounts
                    + " accounts; first-run disclosure needs exactly the seeded one");
        }
        return users.findByEmail(SEEDED_ADMIN_EMAIL)
                .filter(User::isUsable)
                .orElseThrow(() -> notAvailable("the seeded admin account is absent or not usable"));
    }

    private static CpApiException notAvailable(String detail) {
        return new CpApiException(HttpStatus.FORBIDDEN, CODE_NOT_AVAILABLE, detail);
    }

    private static CpApiException alreadyDisclosed() {
        return new CpApiException(HttpStatus.GONE, CODE_ALREADY_DISCLOSED,
                "The first-run credential was already disclosed for this boot; it is never repeated");
    }
}
