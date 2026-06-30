package com.cc01cc.p.xihe.cp;

import org.junit.jupiter.api.BeforeEach;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("h2")
public abstract class AbstractH2Test {

    @LocalServerPort
    protected int port;

    protected RestTemplate restTemplate;
    public String baseUrl;

    @BeforeEach
    void setUp() {
        this.baseUrl = "http://localhost:" + port;
        this.restTemplate = new RestTemplate();
        // 不抛出 4xx 错误，让测试断言自行处理
        this.restTemplate.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) throws IOException {
                HttpStatus status = HttpStatus.resolve(response.getStatusCode().value());
                return status != null && status.is5xxServerError();
            }
        });
    }

    protected String url(String path) {
        return baseUrl + path;
    }
}
