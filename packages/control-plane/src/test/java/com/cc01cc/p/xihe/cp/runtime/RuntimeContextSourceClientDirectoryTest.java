package com.cc01cc.p.xihe.cp.runtime;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestTemplate;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.*;
import static org.springframework.test.web.client.response.MockRestResponseCreators.*;

class RuntimeContextSourceClientDirectoryTest {
    @Test
    void postsExistingListRouteAndParsesTypedEntries() {
        RestTemplate rest = new RestTemplate();
        MockRestServiceServer server = MockRestServiceServer.bindTo(rest).build();
        server.expect(requestTo("http://runtime/internal/v1/runtime/workspaces/ws-1/files/list"))
                .andExpect(method(HttpMethod.POST))
                .andExpect(header("Authorization", "Bearer service-secret"))
                .andExpect(content().json("{\"path\":\"src\"}"))
                .andRespond(withSuccess("{\"entries\":[{\"name\":\"A.md\",\"path\":\"src/A.md\","
                        + "\"is_dir\":false,\"is_symlink\":false}]}", MediaType.APPLICATION_JSON));
        var result = new RuntimeContextSourceClient(rest, "http://runtime", "service-secret")
                .listDirectory("ws-1", "src");
        assertEquals("ready", result.status());
        assertEquals("src/A.md", result.entries().getFirst().path());
        assertEquals(200, result.httpStatus());
        server.verify();
    }

    @Test
    void fourHundredAndMalformedBodiesFailClosedWithoutRetry() {
        RestTemplate rest = new RestTemplate();
        MockRestServiceServer server = MockRestServiceServer.bindTo(rest).build();
        server.expect(requestTo("http://runtime/internal/v1/runtime/workspaces/ws-1/files/list"))
                .andRespond(withStatus(org.springframework.http.HttpStatus.FORBIDDEN));
        var denied = new RuntimeContextSourceClient(rest, "http://runtime", "token").listDirectory("ws-1", ".");
        assertEquals("failed", denied.status());
        assertEquals(403, denied.httpStatus());
        server.verify();

        RestTemplate malformedRest = new RestTemplate();
        MockRestServiceServer malformedServer = MockRestServiceServer.bindTo(malformedRest).build();
        malformedServer.expect(requestTo("http://runtime/internal/v1/runtime/workspaces/ws-1/files/list"))
                .andRespond(withSuccess("{\"unexpected\":[]}", MediaType.APPLICATION_JSON));
        var malformed = new RuntimeContextSourceClient(malformedRest, "http://runtime", "token")
                .listDirectory("ws-1", ".");
        assertEquals("failed", malformed.status());
        assertTrue(malformed.entries().isEmpty());
        malformedServer.verify();
    }
}
