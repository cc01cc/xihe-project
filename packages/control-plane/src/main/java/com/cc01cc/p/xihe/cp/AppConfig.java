package com.cc01cc.p.xihe.cp;

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
        return new RestTemplate();
    }
}
