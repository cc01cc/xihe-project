package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Independent, non-mutating publish/pre-dispatch validation. */
@Service
public class ApiRequestValidator {
    private static final Set<String> SCALARS = Set.of("user_input", "agent_instructions", "model");
    private final ObjectMapper strict = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build());
    private final ApiInputTypeService types;

    public ApiRequestValidator(ApiInputTypeService types) {
        this.types = types;
    }

    public record Diagnostic(String code, String path, String message) { }
    public record Result(boolean valid, List<Diagnostic> diagnostics) { }

    public Result validate(String type, int version, String source) {
        List<Diagnostic> errors = new ArrayList<>();
        if (!types.contains(type, version) || !"chat".equals(types.operation(type, version))) {
            errors.add(new Diagnostic("API_TYPE_OPERATION_MISMATCH", "$", "A Chat API Type is required"));
            return new Result(false, List.copyOf(errors));
        }
        try {
            JsonNode body = strict.readTree(source == null ? "" : source);
            if (body == null || !body.isObject()) {
                errors.add(new Diagnostic("INVALID_JSON", "$", "Request body must be an object"));
            } else {
                String input = "mimo-responses".equals(type) ? "input" : "messages";
                if (!body.path(input).isArray()) {
                    errors.add(new Diagnostic("INVALID_REQUEST_SHAPE", "$.", input + " must be an array"));
                }
                if (!"${xh.model}".equals(body.path("model").asText())) {
                    errors.add(new Diagnostic("RUNTIME_FIELD_CONFLICT", "$.model", "Use the read-only model slot"));
                }
                if (body.has("tools") && !body.path("tools").isArray()) {
                    errors.add(new Diagnostic("INVALID_REQUEST_SHAPE", "$.tools", "tools must be an array"));
                }
                if ("anthropic-messages".equals(type)
                        && (!body.path("max_tokens").isIntegralNumber() || body.path("max_tokens").asInt() < 1)) {
                    errors.add(new Diagnostic("INVALID_REQUEST_SHAPE", "$.max_tokens", "A positive max_tokens is required"));
                }
                walk(body, body, "$", input, type, errors);
            }
        } catch (java.io.IOException e) {
            errors.add(new Diagnostic("INVALID_JSON", "$", "Invalid JSON or duplicate object key"));
        }
        return new Result(errors.isEmpty(), List.copyOf(errors));
    }

    private void walk(JsonNode root, JsonNode value, String path, String input, String type,
                      List<Diagnostic> errors) {
        if (value.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> fields = value.fields();
            while (fields.hasNext()) {
                var field = fields.next();
                if (!variableTokens(field.getKey(), path, errors).isEmpty()) {
                    errors.add(new Diagnostic("INVALID_VARIABLE_POSITION", path, "Variables cannot occur in object keys"));
                }
                if (Set.of("api_key", "apiKey", "api-key", "apikey", "authorization", "credentials",
                        "credential", "headers", "endpoint", "baseUrl", "baseurl").contains(field.getKey())) {
                    errors.add(new Diagnostic("RUNTIME_FIELD_CONFLICT", path, "Transport and credentials are runtime-owned"));
                }
                String childPath = field.getKey().matches("[a-zA-Z_][a-zA-Z0-9_]*")
                        ? path + "." + field.getKey() : path + "['" + field.getKey() + "']";
                walk(root, field.getValue(), childPath, input, type, errors);
            }
        } else if (value.isArray()) {
            for (int i = 0; i < value.size(); i++) {
                walk(root, value.get(i), path + "[" + i + "]", input, type, errors);
            }
        } else if (value.isTextual()) {
            String original = value.asText();
            for (String token : variableTokens(original, path, errors)) {
                String name = token.substring(5, token.length() - 1);
                boolean history = name.equals("conversation_history") && original.equals(token)
                        && path.matches("\\$\\." + input + "\\[\\d+]");
                boolean tools = name.equals("tools") && original.equals(token)
                        && path.matches("\\$\\.tools\\[\\d+]");
                boolean scalar = SCALARS.contains(name) && !path.startsWith("$.tools[")
                        && (!name.equals("model") || (path.equals("$.model") && original.equals(token)));
                boolean rag = name.equals("rag_context") && ragPosition(root, path, type);
                if (!history && !tools && !scalar && !rag) {
                    errors.add(new Diagnostic("INVALID_VARIABLE_POSITION", path, "Unknown variable or invalid slot"));
                }
            }
            if (path.startsWith("$.tools[") && !original.equals("${xh.tools}")) {
                errors.add(new Diagnostic("RUNTIME_FIELD_CONFLICT", path, "Tools must come from authorized tool slots"));
            }
        }
        if (path.matches("\\$\\.tools\\[\\d+]") && !value.isTextual()) {
            errors.add(new Diagnostic("RUNTIME_FIELD_CONFLICT", path, "Literal tools are forbidden"));
        }
    }

    /** Left-to-right scanner mirrored by Agent tokenize; never activates nested foreign literals. */
    private List<String> variableTokens(String value, String path, List<Diagnostic> errors) {
        List<String> tokens = new ArrayList<>();
        int cursor = 0;
        while (cursor < value.length()) {
            boolean escaped = value.startsWith("$${", cursor);
            if (!escaped && !value.startsWith("${", cursor)) {
                cursor++;
                continue;
            }
            int start = cursor + (escaped ? 3 : 2);
            int end = value.indexOf('}', start);
            String name = value.substring(start, end < 0 ? value.length() : end);
            boolean xh = name.equals("xh") || name.startsWith("xh.");
            if (!escaped && xh) {
                if (end < 0 || !name.matches("xh\\.[a-z_]+")) {
                    errors.add(new Diagnostic("INVALID_VARIABLE_TOKEN", path, "Malformed xh variable"));
                } else {
                    tokens.add("${" + name + "}");
                }
            }
            cursor = end < 0 ? value.length() : end + 1;
        }
        return tokens;
    }

    /** Uses the same escaped-token consumption as publish validation. */
    public boolean usesRagContext(JsonNode snapshot) {
        if (snapshot == null || snapshot.isNull()) {
            return false;
        }
        String source = snapshot.path("template").path("bodySource").asText("");
        try {
            return containsRag(strict.readTree(source));
        } catch (java.io.IOException e) {
            throw new IllegalArgumentException("Invalid admission template JSON", e);
        }
    }

    private boolean containsRag(JsonNode node) {
        if (node == null) {
            return false;
        }
        if (node.isTextual()) {
            return variableTokens(node.asText(), "$", new ArrayList<>()).contains("${xh.rag_context}");
        }
        if (node.isObject()) {
            Iterator<String> keys = node.fieldNames();
            while (keys.hasNext()) {
                if (variableTokens(keys.next(), "$", new ArrayList<>()).contains("${xh.rag_context}")) {
                    return true;
                }
            }
        }
        for (JsonNode child : node) {
            if (containsRag(child)) {
                return true;
            }
        }
        return false;
    }

    private boolean ragPosition(JsonNode root, String path, String type) {
        if ("mimo-responses".equals(type)) {
            Matcher item = Pattern.compile("\\$\\.input\\[(\\d+)]\\.content").matcher(path);
            if (!item.matches()) {
                return false;
            }
            JsonNode record = root.path("input").path(Integer.parseInt(item.group(1)));
            return record.path("role").isTextual()
                    && Set.of("user", "assistant", "tool").contains(record.path("role").asText());
        }
        Matcher message = Pattern.compile("\\$\\.messages\\[(\\d+)]\\.content(.*)").matcher(path);
        if (!message.matches()) {
            return false;
        }
        JsonNode item = root.path("messages").path(Integer.parseInt(message.group(1)));
        String role = item.path("role").asText();
        if ("openai-chat-completions".equals(type)) {
            return Set.of("user", "assistant", "tool").contains(role) && message.group(2).isEmpty();
        }
        if (!"anthropic-messages".equals(type) || !Set.of("user", "assistant").contains(role)) {
            return false;
        }
        Matcher block = Pattern.compile("\\[(\\d+)]\\.(text|content)").matcher(message.group(2));
        if (!block.matches()) {
            return false;
        }
        String blockType = item.path("content").path(Integer.parseInt(block.group(1))).path("type").asText();
        return block.group(2).equals("text") && blockType.equals("text")
                || block.group(2).equals("content") && blockType.equals("tool_result");
    }
}
