package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ApiRequestRagValidatorTest {
    private final ObjectMapper json = new ObjectMapper();
    private final ApiRequestValidator validator = new ApiRequestValidator(new ApiInputTypeService(json));

    @Test
    void openAiOnlyAllowsDataRoles() {
        for (String role : new String[]{"user", "assistant", "tool"}) {
            assertTrue(validator.validate("openai-chat-completions", 1, body(role)).valid());
        }
        for (String role : new String[]{"system", "developer"}) {
            assertFalse(validator.validate("openai-chat-completions", 1, body(role)).valid());
        }
        assertFalse(validator.validate("openai-chat-completions", 1,
                body("user").replace("\"role\":\"user\"", "\"role\":\"${xh.rag_context}\"")).valid());
        assertFalse(validator.validate("openai-chat-completions", 1,
                body("user").replace("\"content\"", "\"${xh.rag_context}\"")).valid());
    }

    @Test
    void anthropicAndMimoUseTheirNativeDataPaths() {
        String anthropic = """
                {"model":"${xh.model}","max_tokens":100,"messages":[{"role":"user",
                 "content":[{"type":"text","text":"${xh.rag_context}"},
                 {"type":"tool_result","content":"${xh.rag_context}"}]}]}
                """;
        assertTrue(validator.validate("anthropic-messages", 1, anthropic).valid());
        assertFalse(validator.validate("anthropic-messages", 1,
                anthropic.replace("\"role\":\"user\"", "\"role\":\"system\"")).valid());
        assertFalse(validator.validate("anthropic-messages", 1,
                anthropic.replace("tool_result", "image")).valid());
        String mimo = """
                {"model":"${xh.model}","input":[{"role":"user","content":"${xh.rag_context}"}]}
                """;
        assertTrue(validator.validate("mimo-responses", 1, mimo).valid());
        for (String role : new String[]{"system", "developer", "${xh.user_input}"}) {
            assertFalse(validator.validate("mimo-responses", 1,
                    mimo.replace("\"role\":\"user\"", "\"role\":\"" + role + "\"")).valid());
        }
        assertFalse(validator.validate("mimo-responses", 1,
                mimo.replace("\"input\":", "\"instructions\":\"${xh.rag_context}\",\"input\":")).valid());
    }

    @Test
    void literalObjectKeysCannotImpersonateNativeContentPaths() {
        assertFalse(validator.validate("openai-chat-completions", 1, """
                {"model":"${xh.model}","messages":[{"role":"user","content":"safe"}],
                 "messages[0].content":"${xh.rag_context}"}
                """).valid());
        assertFalse(validator.validate("mimo-responses", 1, """
                {"model":"${xh.model}","input":[{"role":"user","content":"safe"}],
                 "input[0].content":"${xh.rag_context}"}
                """).valid());
    }

    @Test
    void foreignLiteralDoesNotActivateNestedRagToken() {
        for (String literal : new String[]{"${foreign.${xh.rag_context}}", "$${xh.rag_context}",
                "$${foreign.${xh.rag_context}}"}) {
            String source = body("user").replace("${xh.rag_context}", literal);
            var snapshot = json.createObjectNode();
            snapshot.putObject("template").put("bodySource", source);
            assertFalse(validator.usesRagContext(snapshot), literal);
            assertTrue(validator.validate("openai-chat-completions", 1, source).valid(), literal);
        }
    }

    @Test
    void escapedTokensDoNotTriggerProfileResolution() {
        var snapshot = json.createObjectNode();
        snapshot.putObject("template").put("bodySource", body("user").replace("${xh.rag_context}", "$${xh.rag_context}"));
        assertFalse(validator.usesRagContext(snapshot));
        assertTrue(validator.validate("openai-chat-completions", 1,
                snapshot.path("template").path("bodySource").asText()).valid());
        snapshot.withObject("template").put("bodySource", body("user"));
        assertTrue(validator.usesRagContext(snapshot));
    }

    private String body(String role) {
        return "{\"model\":\"${xh.model}\",\"messages\":[{\"role\":\"" + role
                + "\",\"content\":\"${xh.rag_context}\"}]}";
    }
}
