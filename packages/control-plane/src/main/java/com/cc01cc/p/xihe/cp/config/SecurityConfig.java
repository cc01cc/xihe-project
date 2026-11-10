package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.plugin.kv.PluginKvTokenFilter;
import com.cc01cc.p.xihe.cp.policy.CapabilityAuthorities;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.DispatcherType;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpMethod;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.core.Authentication;
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
    private final PluginKvTokenFilter pluginKvTokenFilter;
    private final boolean pluginEnabled;

    public SecurityConfig(JwtAuthenticationFilter jwtAuthenticationFilter,
                          InternalTokenFilter internalTokenFilter,
                          PluginKvTokenFilter pluginKvTokenFilter,
                          @Value("${cp.plugin.enabled:false}") boolean pluginEnabled) {
        this.jwtAuthenticationFilter = jwtAuthenticationFilter;
        this.internalTokenFilter = internalTokenFilter;
        this.pluginKvTokenFilter = pluginKvTokenFilter;
        this.pluginEnabled = pluginEnabled;
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
                // task-244 / PLAN-0763 D-800: springdoc debug surfaces are OFF by default
                // (application.properties: springdoc.*.enabled=false). These permits only
                // matter when a profile or XIHE_SPRINGDOC_ENABLED explicitly turns them on;
                // with springdoc disabled the handlers do not exist, so the paths answer 404
                // and the permit is unreachable rather than a standing anonymous hole.
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
                // PLAN-0610 W1b (R2-5): the URL layer no longer speaks role names. Every public
                // route only requires an authenticated principal; the two sensitive endpoints that
                // had no method-level guard are gated by the instance-administration capability.
                .requestMatchers(HttpMethod.POST, "/api/v1/logs")
                    .hasAuthority(CapabilityAuthorities.CAP_INSTANCE_ADMIN)
                .requestMatchers(HttpMethod.PUT, "/api/v1/instance/owner")
                    .hasAuthority(CapabilityAuthorities.CAP_INSTANCE_ADMIN)
                // /api/v1/mcp is the one prefix shared with the service identity; both a user
                // token and the internal service token authenticate, so `authenticated()` keeps
                // the pre-existing mixed surface without naming a role.
                .requestMatchers("/api/v1/mcp", "/api/v1/mcp/**").authenticated()
                // A human-user surface: the service identity keeps its own channels
                // (/internal/** and /api/v1/mcp) and must not gain the user API just because it
                // is "authenticated" (PLAN-0610 W1b keeps the pre-existing denial).
                .requestMatchers("/api/v1/**").access((authentication, context) -> userPrincipalOnly(authentication.get()))
                // PLAN-0691 T1.5 (SEC-1): the plugin KV data plane accepts exactly one credential —
                // a binding-scoped token minted by PluginKvTokenService. It is deliberately registered
                // *before* the /internal/v1/** role rule: SEC-1 says the global ROLE_INTERNAL_SERVICE
                // token is 403 on this surface, which only holds if this matcher wins first.
                // PLAN-0691 T2.3 adds the records data plane (API-5..API-7): same credential, same
                // authority, so it belongs on the same rule rather than a second one that could drift.
                .requestMatchers(PluginKvTokenFilter.KV_PATH_PATTERN,
                        PluginKvTokenFilter.RECORDS_PATH_PATTERN)
                    .access((authentication, context) -> pluginKvDataPlane(authentication.get()))
                // Service authentication is not user authorization: the service role is unchanged
                // (ROLE_INTERNAL_SERVICE) and the nine internal @PreAuthorize expressions depend
                // on it (W1b-2 keeps them as-is).
                .requestMatchers("/internal/v1/**").hasRole("INTERNAL_SERVICE")
                .anyRequest().authenticated()
            )
            .addFilterBefore(internalTokenFilter, UsernamePasswordAuthenticationFilter.class)
            .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class)
            // Registered last so the binding claims it publishes are the ones the KV controller
            // reads. The other two filters only ever *add* authentication for credentials they can
            // verify (neither can verify a binding token: it is signed with a different key), so they
            // cannot clobber what this one sets.
            .addFilterBefore(pluginKvTokenFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }

    /**
     * PLAN-0610 W1b (R2-5): {@code /api/v1/**} means "an authenticated human principal". The
     * service identity is authenticated too, so it is excluded explicitly instead of by naming a
     * role; a user token never carries the service capability.
     */
    private static AuthorizationDecision userPrincipalOnly(Authentication auth) {
        // Note: AnonymousAuthenticationToken#isAuthenticated() is true, so anonymous must be
        // excluded explicitly — otherwise an unauthenticated call would reach the controller and
        // the chain would answer 500 instead of 401.
        boolean anonymous = auth instanceof AnonymousAuthenticationToken;
        boolean serviceIdentity = auth != null && auth.getAuthorities().stream()
                .anyMatch(authority -> CapabilityAuthorities.CAP_INTERNAL_SERVICE
                                .equals(authority.getAuthority())
                        || CapabilityAuthorities.LEGACY_ROLE_INTERNAL_SERVICE
                                .equals(authority.getAuthority()));
        return new AuthorizationDecision(
                auth != null && auth.isAuthenticated() && !anonymous && !serviceIdentity);
    }

    /**
     * PLAN-0691 T1.5: the plugin KV data plane's URL rule (spec/data-plane.md SEC-1/SEC-2, D-66).
     *
     * <p>Two different answers on purpose:
     * <ul>
     *   <li><b>feature off</b> — allow the request through. D-66 says a flagged-off plugin feature
     *       must look like a build without it, and the KV controller is not registered in that case,
     *       so the request falls through to the dispatcher and the error dispatch answers 404. Had
     *       this rule denied instead, the same call would answer 401/403, i.e. the disabled feature
     *       would still be observed as "exists but forbidden" — the opposite of the flag's contract.</li>
     *   <li><b>feature on</b> — require {@link PluginKvTokenFilter#AUTHORITY}, which only
     *       {@link PluginKvTokenFilter} grants after verifying signature and {@code exp}. An
     *       anonymous caller is denied and therefore gets the chain's 401; a caller holding the
     *       internal service token or a user token is authenticated but lacks the authority, and gets
     *       403 — exactly the split SEC-1 asks for.</li>
     * </ul>
     */
    private AuthorizationDecision pluginKvDataPlane(Authentication auth) {
        if (!pluginEnabled) {
            return new AuthorizationDecision(true);
        }
        boolean anonymous = auth instanceof AnonymousAuthenticationToken;
        boolean bindingToken = auth != null && auth.isAuthenticated() && !anonymous
                && auth.getAuthorities().stream()
                        .anyMatch(authority -> PluginKvTokenFilter.AUTHORITY.equals(authority.getAuthority()));
        return new AuthorizationDecision(bindingToken);
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
        // PLAN-0558: let browser clients read the login throttle contract.
        configuration.setExposedHeaders(List.of("Retry-After", "X-Request-Id"));
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }
}




