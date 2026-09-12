package com.cc01cc.p.xihe.cp;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.security.autoconfigure.UserDetailsServiceAutoConfiguration;
import org.springframework.context.annotation.Bean;

import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication(exclude = UserDetailsServiceAutoConfiguration.class)
@EnableScheduling
public class CpApplication {

    private static final Logger logger = LoggerFactory.getLogger(CpApplication.class);

    public static void main(String[] args) {
        // PLAN-0307 T3.1/T3.5: env chain + CLI --set load before Spring starts.
        DotenvLoader.load(args);
        // PLAN-0307 T3.4: reject dangerous factory defaults in prod (WARN in dev/test).
        SecurityDefaultsValidator.enforce();
        SpringApplication.run(CpApplication.class, args);
    }

    @Bean
    public ApplicationRunner logStartup(
            @Value("${server.port:12631}") String serverPort,
            @Value("${cp.agent-url:http://localhost:12632/internal/v1/agent/chat}") String agentUrl,
            @Value("${cp.mcp.runtime-url:http://localhost:12633/internal/v1/runtime/workspaces/default/mcp}") String runtimeUrl) {
        return args -> logger.info(
            "xihe Control Plane listening on http://localhost:{} (agent={}, runtime={})",
            serverPort,
            agentUrl,
            runtimeUrl
        );
    }
}
