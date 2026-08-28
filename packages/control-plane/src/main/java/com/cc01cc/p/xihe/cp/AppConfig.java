package com.cc01cc.p.xihe.cp;

import com.cc01cc.p.xihe.cp.logging.RequestIdFilter;
import org.slf4j.MDC;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestTemplate;

import java.time.Duration;

@Configuration
public class AppConfig {

    @Bean
    public RestTemplate restTemplate() {
        // Configure RestTemplate with timeouts for MCP proxy
        // No hard timeout on the client side - let tools run as long as needed
        // The timeout is configured per-tool via cp.mcp.timeout.* properties
        RestTemplate restTemplate = new RestTemplate();
        restTemplate.getInterceptors().add((request, body, execution) -> {
            String requestId = MDC.get(RequestIdFilter.MDC_KEY);
            if (requestId != null && !requestId.isBlank()) {
                request.getHeaders().set(RequestIdFilter.HEADER, requestId);
            }
            return execution.execute(request, body);
        });
        return restTemplate;
    }
}
