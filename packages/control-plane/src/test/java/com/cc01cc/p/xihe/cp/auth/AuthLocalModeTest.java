package com.cc01cc.p.xihe.cp.auth;

import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0526: local-mode gate matrix (I1), single-user rule (I2) and the
 * password-omitted register branch. Pure unit tests; no Spring context.
 */
class AuthLocalModeTest {

    @AfterEach
    void clearEnv() {
        System.clearProperty("XIHE_LOCAL_MODE");
        System.clearProperty("XIHE_ENV");
    }

    private static HttpServletRequest request(String remoteAddr, String origin, String host) {
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getRemoteAddr()).thenReturn(remoteAddr);
        when(request.getHeader("Origin")).thenReturn(origin);
        when(request.getHeader("Host")).thenReturn(host);
        return request;
    }

    @Test
    void requireLocalAccess_disabled_returns404() {
        LocalModeService service = new LocalModeService("127.0.0.1");
        assertThrows(IllegalArgumentException.class,
                () -> service.requireLocalAccess(request("127.0.0.1", "http://localhost", "localhost")));
    }

    @Test
    void requireLocalAccess_nonLoopbackRemote_returns404() {
        System.setProperty("XIHE_LOCAL_MODE", "true");
        LocalModeService service = new LocalModeService("127.0.0.1");
        assertThrows(IllegalArgumentException.class,
                () -> service.requireLocalAccess(request("192.168.1.10", null, "127.0.0.1")));
    }

    @Test
    void requireLocalAccess_externalOrigin_returns404() {
        System.setProperty("XIHE_LOCAL_MODE", "true");
        LocalModeService service = new LocalModeService("127.0.0.1");
        assertThrows(IllegalArgumentException.class,
                () -> service.requireLocalAccess(request("127.0.0.1", "http://evil.example.com", "127.0.0.1")));
    }

    @Test
    void requireLocalAccess_rebindingHostWithoutOrigin_returns404() {
        System.setProperty("XIHE_LOCAL_MODE", "true");
        LocalModeService service = new LocalModeService("127.0.0.1");
        assertThrows(IllegalArgumentException.class,
                () -> service.requireLocalAccess(request("127.0.0.1", null, "evil.example.com:12631")));
    }

    @Test
    void requireLocalAccess_loopbackOrigin_passes() {
        System.setProperty("XIHE_LOCAL_MODE", "true");
        LocalModeService service = new LocalModeService("127.0.0.1");
        assertDoesNotThrow(
                () -> service.requireLocalAccess(request("127.0.0.1", "http://localhost:12630", "127.0.0.1")));
    }

    @Test
    void requireLocalAccess_absentOriginLoopbackHost_passes() {
        System.setProperty("XIHE_LOCAL_MODE", "true");
        LocalModeService service = new LocalModeService("127.0.0.1");
        assertDoesNotThrow(() -> service.requireLocalAccess(request("::1", null, "[::1]:12631")));
    }

    @Test
    void validateBinding_enabledNonLoopbackBound_throws() {
        System.setProperty("XIHE_LOCAL_MODE", "true");
        LocalModeService service = new LocalModeService("0.0.0.0");
        assertThrows(IllegalStateException.class, service::validateBinding);
    }

    @Test
    void validateBinding_enabledProd_throws() {
        System.setProperty("XIHE_LOCAL_MODE", "true");
        System.setProperty("XIHE_ENV", "prod");
        LocalModeService service = new LocalModeService("127.0.0.1");
        assertThrows(IllegalStateException.class, service::validateBinding);
    }

    @Test
    void validateBinding_enabledLoopbackNonProd_passes() {
        System.setProperty("XIHE_LOCAL_MODE", "true");
        LocalModeService service = new LocalModeService("127.0.0.1");
        assertDoesNotThrow(service::validateBinding);
    }

    @Test
    void singleNonAdminUser_onlyOne_passes() {
        AuthService authService = AuthTestDoubles.authServiceWithUsers(List.of(oneUser()));
        assertNotNull(authService.requireSingleNonAdminUser());
    }

    @Test
    void singleNonAdminUser_noneOrMany_conflict() {
        assertEquals("LOCAL_SINGLE_USER_REQUIRED", assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> AuthTestDoubles.authServiceWithUsers(List.of()).requireSingleNonAdminUser()).getCode());
        assertEquals("LOCAL_SINGLE_USER_REQUIRED", assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> AuthTestDoubles.authServiceWithUsers(List.of(oneUser(), oneUser()))
                        .requireSingleNonAdminUser()).getCode());
    }

    @Test
    void register_missingPasswordNonLocal_returns400() {
        AuthController controller = AuthTestDoubles.controller(false);
        RegisterRequest request = new RegisterRequest("a@b.com", null, "A");
        IllegalArgumentException thrown = assertThrows(IllegalArgumentException.class,
                () -> controller.register(request, request(null, null, null)));
        assertEquals("password is required", thrown.getMessage());
    }

    @Test
    void register_missingPasswordLocalNonLoopback_returns404() {
        AuthController controller = AuthTestDoubles.controller(true);
        RegisterRequest request = new RegisterRequest("a@b.com", null, "A");
        assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> controller.register(request, request("192.168.1.10", null, "127.0.0.1")));
    }

    private static com.cc01cc.p.xihe.cp.entity.User oneUser() {
        return new com.cc01cc.p.xihe.cp.entity.User(
                "local@test.com", "hash", com.cc01cc.p.xihe.cp.entity.UserRole.USER, "Local");
    }

    /** Shared stubs so each test stays a one-liner. */
    static final class AuthTestDoubles {

        static AuthService authServiceWithUsers(List<com.cc01cc.p.xihe.cp.entity.User> users) {
            com.cc01cc.p.xihe.cp.repository.UserRepository userRepository =
                    mock(com.cc01cc.p.xihe.cp.repository.UserRepository.class);
            when(userRepository.findByRole(com.cc01cc.p.xihe.cp.entity.UserRole.USER)).thenReturn(users);
            return new AuthService(userRepository,
                    mock(org.springframework.security.crypto.password.PasswordEncoder.class),
                    mock(com.cc01cc.p.xihe.cp.config.JwtTokenProvider.class),
                    mock(com.cc01cc.p.xihe.cp.policy.GrantDefaultService.class));
        }

        static AuthController controller(boolean localModeEnabled) {
            AuthService authService = mock(AuthService.class);
            com.cc01cc.p.xihe.cp.service.WorkspaceService workspaceService =
                    mock(com.cc01cc.p.xihe.cp.service.WorkspaceService.class);
            LocalModeService localModeService = new LocalModeService("127.0.0.1") {
                @Override
                public boolean enabled() {
                    return localModeEnabled;
                }
            };
            return new AuthController(authService, workspaceService, localModeService,
                    mock(org.springframework.transaction.PlatformTransactionManager.class));
        }

        private AuthTestDoubles() {}
    }
}
