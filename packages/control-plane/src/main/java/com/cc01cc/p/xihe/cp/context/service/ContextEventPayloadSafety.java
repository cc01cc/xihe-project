package com.cc01cc.p.xihe.cp.context.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Fail-closed durable and response projection for tool result bodies. */
public final class ContextEventPayloadSafety {
    public static final String UNSAFE_TOOL_RESULT_PLACEHOLDER =
            "Tool result withheld from durable history because no checkpoint-safe output schema is registered.";
    public static final String CREDENTIAL_RESULT_PLACEHOLDER =
            "<credential value delivered in-memory; single-use lease, five minute TTL>";

    private static final Set<String> NATIVE_API_TYPES = Set.of(
            "openai-chat-completions", "anthropic-messages", "mimo-responses");
    private static final Set<String> TOOL_STATUSES = Set.of(
            "completed", "failed", "interrupted", "expired", "denied", "timeout", "cancelled", "unknown", "pending");

    private ContextEventPayloadSafety() {
    }

    public static JsonNode sanitize(String eventType, Object payload, ObjectMapper mapper) {
        JsonNode source = payload instanceof JsonNode node ? node.deepCopy() : mapper.valueToTree(payload);
        if (!(source instanceof ObjectNode object)) {
            return switch (eventType) {
                case "tool.result" -> mapper.createObjectNode()
                        .put("result", UNSAFE_TOOL_RESULT_PLACEHOLDER);
                case "assistant.responded", "session.forked" -> mapper.createObjectNode();
                case "context.prune" -> mapper.createObjectNode()
                        .set("tombstones", mapper.createArrayNode());
                default -> source;
            };
        }
        return switch (eventType) {
            case "tool.result" -> sanitizeToolResult(object, mapper);
            case "assistant.responded" -> sanitizeAssistantResponse(object, mapper);
            case "context.prune" -> sanitizePrune(object, mapper);
            case "session.forked" -> sanitizeFork(object, mapper);
            default -> source.deepCopy();
        };
    }

    private static ObjectNode sanitizeToolResult(ObjectNode source, ObjectMapper mapper) {
        ObjectNode safe = mapper.createObjectNode();
        copy(source, safe, "schemaVersion", "toolCallId", "toolName", "runId", "call_id", "tool_name");
        String status = source.path("status").asText("");
        if (TOOL_STATUSES.contains(status)) {
            safe.put("status", status);
        }
        String name = source.path("toolName").asText(source.path("tool_name").asText(""));
        safe.put("result", "acquire_credential".equals(name)
                ? CREDENTIAL_RESULT_PLACEHOLDER : UNSAFE_TOOL_RESULT_PLACEHOLDER);
        return safe;
    }

    private static ObjectNode sanitizePrune(ObjectNode source, ObjectMapper mapper) {
        ObjectNode safe = mapper.createObjectNode();
        if (source.path("pruned_count").canConvertToInt() && source.path("pruned_count").asInt() >= 0) {
            safe.set("pruned_count", source.get("pruned_count").deepCopy());
        }
        if (source.path("runId").isTextual() && source.path("runId").asText().length() <= 128) {
            safe.set("runId", source.get("runId").deepCopy());
        }
        ArrayNode tombstones = mapper.createArrayNode();
        JsonNode rawTombstones = source.get("tombstones");
        if (rawTombstones instanceof ArrayNode values) {
            for (JsonNode raw : values) {
                if (!(raw instanceof ObjectNode tombstone)) {
                    continue;
                }
                ObjectNode clean = mapper.createObjectNode();
                if (tombstone.path("tool_call_id").isTextual()
                        && tombstone.path("tool_call_id").asText().length() <= 128) {
                    clean.set("tool_call_id", tombstone.get("tool_call_id").deepCopy());
                }
                if (tombstone.path("sequence").canConvertToLong()
                        && tombstone.path("sequence").asLong() >= 0) {
                    clean.set("sequence", tombstone.get("sequence").deepCopy());
                }
                String hash = tombstone.path("content_hash").asText("");
                if (hash.matches("(?i)[0-9a-f]{64}")) {
                    clean.put("content_hash", hash);
                }
                if (tombstone.path("size").canConvertToLong() && tombstone.path("size").asLong() >= 0) {
                    clean.set("size", tombstone.get("size").deepCopy());
                }
                if (tombstone.path("pruned").isBoolean()) {
                    clean.set("pruned", tombstone.get("pruned").deepCopy());
                }
                String reason = tombstone.path("reason").asText("");
                if (Set.of("duplicate", "oversized", "window").contains(reason)) {
                    clean.put("reason", reason);
                }
                // Durable tombstones retain only occurrence/hash metadata. Their
                // head/tail fields are previews of the withheld tool output.
                tombstones.add(clean);
            }
        }
        safe.set("tombstones", tombstones);
        return safe;
    }

    private static ObjectNode sanitizeFork(ObjectNode source, ObjectMapper mapper) {
        ObjectNode safe = mapper.createObjectNode();
        copy(source, safe, "source_session_id", "anchor_message_id", "at_sequence");
        JsonNode rawSeed = source.get("summary_seed");
        if (!(rawSeed instanceof ObjectNode seed)) {
            return safe;
        }
        ObjectNode cleanSeed = mapper.createObjectNode();
        copy(seed, cleanSeed, "contextEpoch", "summary", "summaryHash");
        JsonNode rawMessages = seed.get("messages");
        if (rawMessages instanceof ArrayNode messages) {
            ArrayNode cleanMessages = mapper.createArrayNode();
            for (JsonNode rawMessage : messages) {
                if (rawMessage instanceof ObjectNode message) {
                    cleanMessages.add(sanitizeMessage(message, mapper));
                }
            }
            cleanSeed.set("messages", cleanMessages);
        }
        safe.set("summary_seed", cleanSeed);
        return safe;
    }

    private static ObjectNode sanitizeAssistantResponse(ObjectNode source, ObjectMapper mapper) {
        ObjectNode safe = source.deepCopy();
        JsonNode rawMessage = source.get("message");
        if (rawMessage instanceof ObjectNode message) {
            safe.set("message", sanitizeMessage(message, mapper));
        } else if (source.has("nativeRecords")) {
            safe.set("nativeRecords", sanitizeNativeRecords(
                    source.path("apiTypeId").asText(""), source.get("nativeRecords"), mapper));
        } else if ("tool".equals(source.path("role").asText(""))) {
            String name = source.path("tool_name").asText("");
            safe.put("content", "acquire_credential".equals(name)
                    ? CREDENTIAL_RESULT_PLACEHOLDER : UNSAFE_TOOL_RESULT_PLACEHOLDER);
            removeToolPreviewMetadata(safe);
        }
        return safe;
    }

    private static ObjectNode sanitizeMessage(ObjectNode source, ObjectMapper mapper) {
        ObjectNode safe = source.deepCopy();
        if ("tool".equals(source.path("role").asText(""))) {
            String name = source.path("tool_name").asText("");
            safe.put("content", "acquire_credential".equals(name)
                    ? CREDENTIAL_RESULT_PLACEHOLDER : UNSAFE_TOOL_RESULT_PLACEHOLDER);
            removeToolPreviewMetadata(safe);
        }
        if (source.has("nativeRecords")) {
            String apiTypeId = source.path("apiTypeId").asText("");
            safe.set("nativeRecords", sanitizeNativeRecords(apiTypeId, source.get("nativeRecords"), mapper));
        }
        return safe;
    }

    private static ArrayNode sanitizeNativeRecords(String apiTypeId, JsonNode source, ObjectMapper mapper) {
        ArrayNode safe = mapper.createArrayNode();
        if (!NATIVE_API_TYPES.contains(apiTypeId) || source == null || !source.isArray()) {
            return safe;
        }
        Set<String> credentialCallIds = credentialCallIds(apiTypeId, source);
        for (JsonNode raw : source) {
            if (!(raw instanceof ObjectNode record)) {
                continue;
            }
            ObjectNode clean = record.deepCopy();
            if (apiTypeId.equals("openai-chat-completions")) {
                String role = record.path("role").asText("");
                if (role.equals("tool") || role.equals("function")) {
                    clean = mapper.createObjectNode();
                    copy(record, clean, "role", "name", "tool_call_id");
                    String callId = record.path("tool_call_id").asText(record.path("id").asText(""));
                    clean.put("content", credentialCallIds.contains(callId)
                            ? CREDENTIAL_RESULT_PLACEHOLDER : UNSAFE_TOOL_RESULT_PLACEHOLDER);
                }
            } else if (apiTypeId.equals("anthropic-messages")) {
                JsonNode content = record.get("content");
                if (content instanceof ArrayNode blocks) {
                    ArrayNode cleanBlocks = mapper.createArrayNode();
                    for (JsonNode block : blocks) {
                        if (!(block instanceof ObjectNode object)
                                || !object.path("type").asText("").equals("tool_result")) {
                            cleanBlocks.add(block.deepCopy());
                            continue;
                        }
                        String callId = object.path("tool_use_id").asText("");
                        ObjectNode result = mapper.createObjectNode();
                        copy(object, result, "type", "tool_use_id", "is_error");
                        String placeholder = credentialCallIds.contains(callId)
                                ? CREDENTIAL_RESULT_PLACEHOLDER : UNSAFE_TOOL_RESULT_PLACEHOLDER;
                        if (object.path("content").isArray()) {
                            result.set("content", mapper.createArrayNode().add(
                                    mapper.createObjectNode().put("type", "text").put("text", placeholder)));
                        } else {
                            result.put("content", placeholder);
                        }
                        cleanBlocks.add(result);
                    }
                    clean.set("content", cleanBlocks);
                }
            } else if (record.path("type").asText("").equals("function_call_output")) {
                clean = mapper.createObjectNode();
                copy(record, clean, "type", "call_id");
                String callId = record.path("call_id").asText("");
                clean.put("output", credentialCallIds.contains(callId)
                        ? CREDENTIAL_RESULT_PLACEHOLDER : UNSAFE_TOOL_RESULT_PLACEHOLDER);
            }
            safe.add(clean);
        }
        return safe;
    }

    private static Set<String> credentialCallIds(String apiTypeId, JsonNode records) {
        Set<String> ids = new HashSet<>();
        for (JsonNode record : records) {
            if (!record.isObject()) {
                continue;
            }
            if (apiTypeId.equals("openai-chat-completions")) {
                JsonNode calls = record.path("tool_calls");
                if (calls.isArray()) {
                    for (JsonNode call : calls) {
                        if (call.path("function").path("name").asText("").equals("acquire_credential")) {
                            ids.add(call.path("id").asText(""));
                        }
                    }
                }
            } else if (apiTypeId.equals("anthropic-messages")) {
                JsonNode blocks = record.path("content");
                if (blocks.isArray()) {
                    for (JsonNode block : blocks) {
                        if (block.path("type").asText("").equals("tool_use")
                                && block.path("name").asText("").equals("acquire_credential")) {
                            ids.add(block.path("id").asText(""));
                        }
                    }
                }
            } else if (record.path("type").asText("").equals("function_call")
                    && record.path("name").asText("").equals("acquire_credential")) {
                ids.add(record.path("call_id").asText(""));
            }
        }
        return ids;
    }

    private static void copy(ObjectNode source, ObjectNode target, String... names) {
        for (String name : names) {
            if (source.has(name)) {
                target.set(name, source.get(name).deepCopy());
            }
        }
    }

    private static void removeToolPreviewMetadata(ObjectNode message) {
        for (String field : List.of("artifact_ref", "artifact_status", "size_bytes", "error_code", "truncated")) {
            message.remove(field);
        }
    }
}
