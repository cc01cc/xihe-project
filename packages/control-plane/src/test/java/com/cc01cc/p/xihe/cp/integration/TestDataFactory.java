package com.cc01cc.p.xihe.cp.integration;

import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;

public class TestDataFactory {

    public static final String SECRET = "test-jwt-secret-key-for-testing-purposes";

    public static final String EMAIL_A = "user-a@test.com";
    public static final String EMAIL_B = "user-b@test.com";
    public static final String PASSWORD = "Test1234!";
    public static final String NAME_A = "User A";
    public static final String NAME_B = "User B";

    public static final String WS_1_NAME = "ws-isolation-1";
    public static final String WS_2_NAME = "ws-isolation-2";

    public static final WorkspaceRole ROLE_OWNER = WorkspaceRole.OWNER;
    public static final WorkspaceRole ROLE_MEMBER = WorkspaceRole.MEMBER;

    private static JwtTokenProvider tokenProvider;

    public static JwtTokenProvider tokenProvider() {
        if (tokenProvider == null) {
            tokenProvider = new JwtTokenProvider(SECRET, 900, 604800);
        }
        return tokenProvider;
    }

    public static String createWorkspaceToken(String userId, String email, String role, String workspaceId) {
        return tokenProvider().createAccessToken(userId, email, role, workspaceId);
    }

    public static String createGlobalToken(String userId, String email, String role) {
        return tokenProvider().createAccessToken(userId, email, role, null);
    }
}
