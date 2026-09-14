package com.cc01cc.p.xihe.cp;

import com.cc01cc.p.xihe.cp.logging.RequestIdFilter;
import org.slf4j.MDC;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestTemplate;

import java.time.Duration;

@Configuration
public class AppConfig {

    /**
     * CP → Runtime request factory. A half-dead Runtime (TCP accepted but no
     * response) must fail fast instead of hanging CP request threads (CHN-5).
     */
    private static SimpleClientHttpRequestFactory runtimeRequestFactory(int readTimeoutSeconds) {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(2));
        factory.setReadTimeout(Duration.ofSeconds(readTimeoutSeconds));
        return factory;
    }

    private static RestTemplate withRequestIdPropagation(SimpleClientHttpRequestFactory factory) {
        RestTemplate restTemplate = new RestTemplate(factory);
        restTemplate.getInterceptors().add((request, body, execution) -> {
            String requestId = MDC.get(RequestIdFilter.MDC_KEY);
            if (requestId != null && !requestId.isBlank()) {
                request.getHeaders().set(RequestIdFilter.HEADER, requestId);
            }
            return execution.execute(request, body);
        });
        return restTemplate;
    }

    /**
     * Workspace status, file proxy, context source and materialize trigger:
     * short reads are correct here, a slow Runtime should surface quickly.
     */
    @Bean
    @Primary
    public RestTemplate restTemplate() {
        return withRequestIdPropagation(runtimeRequestFactory(10));
    }

    /**
     * Workspace delete notification. The Runtime side stops the sandbox
     * container, which can block for the Docker stop grace period — observed
     * ~9.9s in the PLAN-0327 M4 host run, i.e. a 10s read timeout is too tight
     * for this call. Cleanup is best-effort after commit, so a generous read
     * budget is preferred over a premature timeout.
     */
    @Bean
    public RestTemplate runtimeCleanupRestTemplate() {
        return withRequestIdPropagation(runtimeRequestFactory(30));
    }
}
