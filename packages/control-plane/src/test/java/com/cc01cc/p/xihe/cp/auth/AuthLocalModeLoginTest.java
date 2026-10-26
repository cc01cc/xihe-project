package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.PlatformTransactionManager;

import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AuthLocalModeLoginTest {

    @Test
    void localModeLogin_doesNotEnterTheLoginThrottle() {
        AuthService authService = mock(AuthService.class);
        WorkspaceService workspaceService = mock(WorkspaceService.class);
        LoginAttemptService attempts = mock(LoginAttemptService.class);
        ClientIpResolver resolver = mock(ClientIpResolver.class);

        User user = new User("local@test.com", "hash", UserRole.ADMIN, "Local");
        user.setId(UUID.randomUUID());
        Workspace workspace = new Workspace();
        workspace.setId(UUID.randomUUID());
        when(authService.authenticate(any(LoginRequest.class))).thenReturn(user);
        when(authService.issueTokens(any(User.class), anyString())).thenReturn(mock(AuthResponse.class));
        when(workspaceService.getOrCreateDefaultWorkspace(anyString())).thenReturn(workspace);
        when(resolver.resolve(any())).thenReturn("127.0.0.1");

        LocalModeService localMode = new LocalModeService("127.0.0.1") {
            @Override
            public boolean enabled() {
                return true;
            }
        };
        AuthController controller = new AuthController(authService, workspaceService, localMode,
                attempts, resolver, mock(PlatformTransactionManager.class));

        controller.login(new LoginRequest("local@test.com", "pw-12345678"),
                new MockHttpServletRequest());

        verify(attempts, never()).beginLogin(anyString(), anyString());
        verify(attempts, never()).tryAcquireBcryptSlot();
    }
}
