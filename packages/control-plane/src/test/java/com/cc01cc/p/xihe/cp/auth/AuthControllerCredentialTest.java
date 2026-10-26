package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.PlatformTransactionManager;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AuthControllerCredentialTest {

    @Test
    void workspaceFailure_isNotCountedAsCredentialFailure() {
        AuthService authService = mock(AuthService.class);
        WorkspaceService workspaceService = mock(WorkspaceService.class);
        LoginAttemptService attempts = mock(LoginAttemptService.class);
        ClientIpResolver resolver = mock(ClientIpResolver.class);

        User user = new User("a@test.com", "hash", UserRole.USER, "A");
        user.setId(UUID.randomUUID());
        when(authService.authenticate(any(LoginRequest.class))).thenReturn(user);
        when(workspaceService.getOrCreateDefaultWorkspace(anyString()))
                .thenThrow(new CpApiException(HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "missing"));
        when(attempts.beginLogin(anyString(), anyString())).thenReturn(null);
        when(attempts.tryAcquireBcryptSlot()).thenReturn(true);
        when(resolver.resolve(any())).thenReturn("203.0.113.5");

        LocalModeService localMode = new LocalModeService("127.0.0.1") {
            @Override
            public boolean enabled() {
                return false;
            }
        };
        AuthController controller = new AuthController(authService, workspaceService, localMode,
                attempts, resolver, mock(PlatformTransactionManager.class));

        assertThrows(CpApiException.class, () -> controller.login(
                new LoginRequest("a@test.com", "pw-12345678"), new MockHttpServletRequest()));
        verify(attempts, never()).recordCredentialFailure(any());
        verify(attempts).release(null);
    }
}
