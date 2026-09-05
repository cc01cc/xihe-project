package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.DispatcherType;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.nio.charset.StandardCharsets;
import java.util.List;

@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {

    private final JwtAuthenticationFilter jwtAuthenticationFilter;
    private final InternalTokenFilter internalTokenFilter;

    public SecurityConfig(JwtAuthenticationFilter jwtAuthenticationFilter,
                          InternalTokenFilter internalTokenFilter) {
        this.jwtAuthenticationFilter = jwtAuthenticationFilter;
        this.internalTokenFilter = internalTokenFilter;
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .exceptionHandling(exceptions -> exceptions
                .authenticationEntryPoint((request, response, authException) -> {
                    response.setContentType("application/problem+json");
                    response.setCharacterEncoding(StandardCharsets.UTF_8.name());
                    response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                    String requestId = java.util.UUID.randomUUID().toString();
                    response.setHeader("X-Request-Id", requestId);
                    response.getWriter().write("{\"type\":\"https://xihe.dev/problems/authorization-required\",\"title\":\"Authorization required\",\"status\":401,\"code\":\"AUTHORIZATION_REQUIRED\",\"detail\":\"Authorization required\",\"requestId\":\"" + requestId + "\"}");
                })
                .accessDeniedHandler((request, response, accessDeniedException) -> {
                    response.setContentType("application/problem+json");
                    response.setCharacterEncoding(StandardCharsets.UTF_8.name());
                    response.setStatus(HttpServletResponse.SC_FORBIDDEN);
                    String requestId = java.util.UUID.randomUUID().toString();
                    response.setHeader("X-Request-Id", requestId);
                    response.getWriter().write("{\"type\":\"https://xihe.dev/problems/forbidden\",\"title\":\"Forbidden\",\"status\":403,\"code\":\"FORBIDDEN\",\"detail\":\"Access denied\",\"requestId\":\"" + requestId + "\"}");
                })
            )
            .authorizeHttpRequests(auth -> auth
                .dispatcherTypeMatchers(DispatcherType.ASYNC, DispatcherType.ERROR).permitAll()
                .requestMatchers("/api/v1/auth/**").permitAll()
                .requestMatchers("/api/v1/oauth/callback").permitAll()
                .requestMatchers("/api/v1/health").permitAll()
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers("/v3/api-docs/**").permitAll()
                .requestMatchers("/swagger-ui/**").permitAll()
                .requestMatchers("/swagger-ui.html").permitAll()
                .requestMatchers("/health").permitAll()
                .requestMatchers("/error").permitAll()
                // XH Channel WS endpoint (PLAN-245): auth is enforced by the
                // ChannelHandshakeInterceptor on the Upgrade request; Spring
                // Security must not pre-empt it, otherwise the Runtime cannot
                // exchange its service token via headers.
                .requestMatchers("/internal/v1/channel").permitAll()
                .requestMatchers("/api/v1/mcp").hasAnyRole("USER", "ADMIN", "INTERNAL_SERVICE")
                .requestMatchers("/api/v1/**").hasAnyRole("USER", "ADMIN")
                .requestMatchers("/internal/v1/**").hasRole("INTERNAL_SERVICE")
                .anyRequest().authenticated()
            )
            .addFilterBefore(internalTokenFilter, UsernamePasswordAuthenticationFilter.class)
            .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration configuration = new CorsConfiguration();
        configuration.setAllowedOrigins(List.of("*"));
        configuration.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"));
        configuration.setAllowedHeaders(List.of("*"));
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }
}
