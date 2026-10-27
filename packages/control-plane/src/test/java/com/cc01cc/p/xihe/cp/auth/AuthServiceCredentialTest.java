package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AuthServiceCredentialTest {

    @Test
    void unknownAccount_stillRunsOneBcryptMatch() {
        UserRepository repository = mock(UserRepository.class);
        PasswordEncoder encoder = mock(PasswordEncoder.class);
        when(repository.findByEmail(anyString())).thenReturn(Optional.empty());
        when(encoder.encode(anyString())).thenReturn("$2a$10$dummy-hash");
        when(encoder.matches(anyString(), anyString())).thenReturn(false);
        AuthService service = service(repository, encoder);

        LoginRequest request = new LoginRequest("missing@test.com", "secret");
        assertThrows(InvalidCredentialsException.class, () -> service.authenticate(request));
        verify(encoder).matches(eq("secret"), eq("$2a$10$dummy-hash"));
    }

    @Test
    void wrongPassword_isCredentialFailure() {
        User user = new User("a@test.com", "stored-hash", UserRole.USER, "A");
        UserRepository repository = mock(UserRepository.class);
        PasswordEncoder encoder = mock(PasswordEncoder.class);
        when(repository.findByEmail("a@test.com")).thenReturn(Optional.of(user));
        when(encoder.encode(anyString())).thenReturn("$2a$10$dummy-hash");
        when(encoder.matches("wrong", "stored-hash")).thenReturn(false);
        AuthService service = service(repository, encoder);

        assertThrows(InvalidCredentialsException.class,
                () -> service.authenticate(new LoginRequest("a@test.com", "wrong")));
        verify(encoder).matches("wrong", "stored-hash");
    }

    @Test
    void validPassword_returnsUser() {
        User user = new User("a@test.com", "stored-hash", UserRole.USER, "A");
        UserRepository repository = mock(UserRepository.class);
        PasswordEncoder encoder = mock(PasswordEncoder.class);
        when(repository.findByEmail("a@test.com")).thenReturn(Optional.of(user));
        when(encoder.encode(anyString())).thenReturn("$2a$10$dummy-hash");
        when(encoder.matches("right", "stored-hash")).thenReturn(true);
        AuthService service = service(repository, encoder);

        assertEquals(user, service.authenticate(new LoginRequest("a@test.com", "right")));
    }

    private static AuthService service(UserRepository repository, PasswordEncoder encoder) {
        return new AuthService(repository, encoder, mock(JwtTokenProvider.class),
                mock(GrantDefaultService.class));
    }
}
