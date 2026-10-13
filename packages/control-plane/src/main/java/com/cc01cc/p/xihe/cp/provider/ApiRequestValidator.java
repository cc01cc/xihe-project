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
    private static final Pattern TOKEN = Pattern.compile("\\$\\{xh\\.([a-z_]+)}");
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
                walk(body, "$", input, errors);
            }
        } catch (java.io.IOException e) {
            errors.add(new Diagnostic("INVALID_JSON", "$", "Invalid JSON or duplicate object key"));
        }
        return new Result(errors.isEmpty(), List.copyOf(errors));
    }

    private void walk(JsonNode value, String path, String input, List<Diagnostic> errors) {
        if (value.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> fields = value.fields();
            while (fields.hasNext()) {
                var field = fields.next();
                if (field.getKey().contains("${")) {
                    errors.add(new Diagnostic("INVALID_VARIABLE_POSITION", path, "Variables cannot occur in object keys"));
                }
                if (Set.of("api_key", "apiKey", "api-key", "apikey", "authorization", "credentials",
                        "credential", "headers", "endpoint", "baseUrl", "baseurl").contains(field.getKey())) {
                    errors.add(new Diagnostic("RUNTIME_FIELD_CONFLICT", path, "Transport and credentials are runtime-owned"));
                }
                walk(field.getValue(), path + "." + field.getKey(), input, errors);
            }
        } else if (value.isArray()) {
            for (int i = 0; i < value.size(); i++) {
                walk(value.get(i), path + "[" + i + "]", input, errors);
            }
        } else if (value.isTextual()) {
            String original = value.asText();
            // Escaped tokens are consumed once and are never checked as active slots.
            String active = original.replaceAll("\\$\\$\\{[^}]*}", "");
            Matcher matcher = TOKEN.matcher(active);
            while (matcher.find()) {
                String name = matcher.group(1);
                boolean history = name.equals("conversation_history") && original.equals(matcher.group())
                        && path.matches("\\$\\." + input + "\\[\\d+]");
                boolean tools = name.equals("tools") && original.equals(matcher.group())
                        && path.matches("\\$\\.tools\\[\\d+]");
                boolean scalar = SCALARS.contains(name) && !path.startsWith("$.tools[")
                        && (!name.equals("model") || (path.equals("$.model") && original.equals(matcher.group())));
                if (!history && !tools && !scalar) {
                    errors.add(new Diagnostic("INVALID_VARIABLE_POSITION", path, "Unknown variable or invalid slot"));
                }
            }
            if (TOKEN.matcher(active).replaceAll("").contains("${xh")) {
                errors.add(new Diagnostic("INVALID_VARIABLE_TOKEN", path, "Malformed xh variable"));
            }
            if (path.startsWith("$.tools[") && !original.equals("${xh.tools}")) {
                errors.add(new Diagnostic("RUNTIME_FIELD_CONFLICT", path, "Tools must come from authorized tool slots"));
            }
        }
        if (path.matches("\\$\\.tools\\[\\d+]") && !value.isTextual()) {
            errors.add(new Diagnostic("RUNTIME_FIELD_CONFLICT", path, "Literal tools are forbidden"));
        }
    }
}
