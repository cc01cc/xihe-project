package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * PLAN-0621 F-06（M3）：框架级 4xx 不得被 {@code @ExceptionHandler(Exception.class)} 兜底吞成 500。
 *
 * <p>有头走查实测：对只支持 POST 的集合端点发 {@code GET /api/v1/workspaces/{id}/sessions}，CP 返回
 * {@code 500 INTERNAL_ERROR "Request failed"}，而正确的答案应是 405（方法不支持）。根因不在该端点，
 * 而在本 handler 的兜底：Spring MVC 抛出的 {@code HttpRequestMethodNotSupportedException}（以及
 * {@code HttpMediaTypeNotSupportedException} 等）没有显式映射，落进了 {@code Exception} 分支。</p>
 *
 * <p>这两个用例就是 F-06 的**复现断言**：先红（当前 500），修好 handler 后转绿；同时约束"错误码不能是
 * INTERNAL_ERROR"，避免有人把它映射成 405 但仍复用 500 的 code。</p>
 */
class ProblemDetailsHandlerFrameworkExceptionsTest {

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.standaloneSetup(new ProbeController())
                .setControllerAdvice(new ProblemDetailsHandler(5000L))
                .build();
    }

    @Test
    void unsupportedMethodAnswers405NotInternalError() throws Exception {
        mockMvc.perform(get("/probe/collection"))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(jsonPath("$.code").value("METHOD_NOT_ALLOWED"))
                .andExpect(jsonPath("$.code").value(org.hamcrest.Matchers.not("INTERNAL_ERROR")))
                .andExpect(jsonPath("$.detail").value(org.hamcrest.Matchers.not("Request failed")));
    }

    @Test
    void unsupportedMediaTypeAnswers415NotInternalError() throws Exception {
        mockMvc.perform(post("/probe/collection")
                        .contentType(MediaType.TEXT_PLAIN)
                        .content("plain text"))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"))
                .andExpect(jsonPath("$.code").value(org.hamcrest.Matchers.not("INTERNAL_ERROR")));
    }

    @Test
    void malformedBodyStillAnswers400() throws Exception {
        // 回归护栏：既有 HttpMessageNotReadableException 映射必须保持不变。
        mockMvc.perform(post("/probe/collection")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{not-json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value(org.hamcrest.Matchers.not("INTERNAL_ERROR")));
        assertNotEquals(500, 400);
    }

    /** 只提供 POST 的探针端点：GET 会触发方法不支持，非 JSON 体会触发媒体类型不支持。 */
    @RestController
    static class ProbeController {

        @PostMapping(value = "/probe/collection", consumes = MediaType.APPLICATION_JSON_VALUE)
        String create(@RequestBody ProbeBody body) {
            return "ok";
        }

        record ProbeBody(String value) {
        }
    }
}
