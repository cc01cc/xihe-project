package com.cc01cc.p.xihe.cp.integration;

import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;

import java.security.SecureRandom;
import java.util.Base64;

public class TestDataFactory {

    private static java.nio.file.Path hostRoot;

    /**
     * PLAN-0618: a <b>persisted</b> fixture row must satisfy the product shape — the database rejects
     * {@code direct_attach} without a hostPath ({@code ck_workspaces_direct_attach_path}). Tests that
     * seed a workspace row directly (rather than through {@code WorkspaceFixture}) use this factory
     * instead of {@code new Workspace(name)}.
     *
     * <p>The host directory is created lazily once per JVM under the system temp dir and registered with
     * {@code deleteOnExit}; each workspace gets its own child directory (also deleteOnExit).
     */
    public static com.cc01cc.p.xihe.cp.entity.Workspace directAttachWorkspace(String name) {
        com.cc01cc.p.xihe.cp.entity.Workspace workspace =
                new com.cc01cc.p.xihe.cp.entity.Workspace(name);
        workspace.setStorageMode("direct_attach");
        workspace.setExecutionMode("windows-host");
        workspace.setHostPath(hostPath());
        return workspace;
    }

    private static synchronized String hostPath() {
        try {
            if (hostRoot == null) {
                hostRoot = java.nio.file.Files.createTempDirectory("xihe-testdata-ws");
                hostRoot.toFile().deleteOnExit();
            }
            java.nio.file.Path child = hostRoot.resolve(java.util.UUID.randomUUID().toString());
            java.nio.file.Files.createDirectories(child);
            child.toFile().deleteOnExit();
            return child.toAbsolutePath().toString();
        } catch (java.io.IOException cause) {
            throw new IllegalStateException("cannot create the fixture host directory", cause);
        }
    }

    private TestDataFactory() {}

    public static final String SECRET = "test-jwt-secret-key-for-testing-purposes";

    private static final int PASSWORD_BYTES = 24;
    private static final SecureRandom RANDOM = new SecureRandom();

    public static final String EMAIL_A = "user-a@test.com";
    public static final String EMAIL_B = "user-b@test.com";
    public static final String PASSWORD = randomPassword();
    public static final String INVALID_PASSWORD = differentPassword(PASSWORD);
    public static final String NAME_A = "User A";
    public static final String NAME_B = "User B";

    public static final String WS_1_NAME = "ws-isolation-1";
    public static final String WS_2_NAME = "ws-isolation-2";

    public static final WorkspaceRole ROLE_OWNER = WorkspaceRole.OWNER;
    public static final WorkspaceRole ROLE_MEMBER = WorkspaceRole.MEMBER;

    private static JwtTokenProvider tokenProvider;

    private static String randomPassword() {
        byte[] bytes = new byte[PASSWORD_BYTES];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String differentPassword(String original) {
        String password;
        do {
            password = randomPassword();
        } while (password.equals(original));
        return password;
    }

    public static JwtTokenProvider tokenProvider() {
        if (tokenProvider == null) {
            tokenProvider = new JwtTokenProvider(SECRET, 900, 604800);
        }
        return tokenProvider;
    }

    /**
     * PLAN-0580: the seam builds its own provider and never touches the database,
     * so the access-token epoch ({@code tv}) cannot be derived here — the caller
     * states it explicitly. Tests that mint a token for a freshly created user
     * pass {@code 0}, which is what V85 initializes {@code users.token_version}
     * to.
     */
    public static String createWorkspaceToken(String userId, String email, String role,
                                              String workspaceId, int tokenVersion) {
        return tokenProvider().createAccessToken(userId, email, role, workspaceId, tokenVersion);
    }

    public static String createGlobalToken(String userId, String email, String role, int tokenVersion) {
        return tokenProvider().createAccessToken(userId, email, role, null, tokenVersion);
    }
}
