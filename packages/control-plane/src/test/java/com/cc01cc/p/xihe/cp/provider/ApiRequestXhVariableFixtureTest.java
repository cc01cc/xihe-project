package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0632 Gate G-0: the Control Plane half of the {@code ${xh.*}} slot contract.
 *
 * <p>Both sides read {@code spec/fixtures/xh-variables.json}; this test pins the CP classification
 * ({@link ApiRequestValidator} SCALARS vs the positional tools/history/rag slots) and replays every
 * fixture case through the real publish validator. The Agent mirror is
 * {@code packages/agent/tests/unit/test_xh_variable_contract.py}.
 *
 * <p>The failure mode this prevents: adding a slot on one side only. A CP-only slot would pass
 * publish validation and then fail at render time ({@code UNKNOWN_VARIABLE}), which is exactly the
 * "authorable but unusable template" trap G-0 exists to close.
 */
class ApiRequestXhVariableFixtureTest {
    private static final String FIXTURE = "xh-variables.json";

    private final ObjectMapper json = new ObjectMapper();
    private final ApiRequestValidator validator = new ApiRequestValidator(new ApiInputTypeService(json));

    /** Walks up from the working directory so the test works from the module dir or the repo root. */
    private static Path fixturePath() {
        Path here = Path.of("").toAbsolutePath();
        for (Path cursor = here; cursor != null; cursor = cursor.getParent()) {
            Path candidate = cursor.resolve("spec").resolve("fixtures").resolve(FIXTURE);
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        throw new AssertionError(FIXTURE + " not found above " + here
                + "; the CP and Agent contract tests must share spec/fixtures/" + FIXTURE);
    }

    private static JsonNode contract() throws Exception {
        return new ObjectMapper().readTree(Files.readString(fixturePath()));
    }

    @Test
    void scalarSlotsMirrorTheSharedFixture() throws Exception {
        Set<String> expected = new TreeSet<>();
        Set<String> positional = new TreeSet<>();
        for (JsonNode slot : contract().path("slots")) {
            if ("scalar".equals(slot.path("cpClass").asText())) {
                expected.add(slot.path("name").asText());
            } else {
                positional.add(slot.path("name").asText());
            }
        }
        assertEquals(expected, new TreeSet<>(ApiRequestValidator.SCALARS),
                "ApiRequestValidator.SCALARS must equal the fixture's cpClass=scalar slots");
        assertEquals(Set.of("rag_context", "tools", "conversation_history"), positional,
                "non-scalar slots keep their dedicated positional rules");
        assertTrue(expected.containsAll(List.of("skill_catalog", "agent_memory")),
                "G-0's two slots must be authorable/publishable in a template");
    }

    @Test
    void fixtureCasesMatchPublishValidation() throws Exception {
        List<String> failures = new ArrayList<>();
        for (JsonNode testCase : contract().path("cases")) {
            String id = testCase.path("id").asText();
            ApiRequestValidator.Result result = validator.validate(
                    testCase.path("apiType").asText(), 1, testCase.path("source").asText());
            boolean expectedValid = testCase.path("cpValid").asBoolean();
            if (result.valid() != expectedValid) {
                failures.add(id + ": expected valid=" + expectedValid + " got " + result.valid()
                        + " diagnostics=" + result.diagnostics());
                continue;
            }
            if (!expectedValid) {
                String expectedCode = testCase.path("cpCode").asText();
                boolean present = result.diagnostics().stream()
                        .anyMatch(diagnostic -> diagnostic.code().equals(expectedCode));
                if (!present) {
                    failures.add(id + ": expected diagnostic " + expectedCode + " got " + result.diagnostics());
                }
            }
        }
        assertTrue(failures.isEmpty(), "fixture/validator drift: " + failures);
    }

    @Test
    void undeclaredSlotIsRejectedNotIgnored() {
        String source = "{\"model\":\"${xh.model}\",\"messages\":[{\"role\":\"user\","
                + "\"content\":\"${xh.not_a_declared_slot}\"}]}";
        ApiRequestValidator.Result result = validator.validate("openai-chat-completions", 1, source);
        assertFalse(result.valid());
        assertTrue(result.diagnostics().stream()
                        .anyMatch(diagnostic -> diagnostic.code().equals("INVALID_VARIABLE_POSITION")),
                "an undeclared variable must fail loudly, never be accepted as an empty slot");
    }

    @Test
    void newSlotsAreRejectedInsideTheToolsArray() {
        String source = "{\"model\":\"${xh.model}\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}],"
                + "\"tools\":[\"${xh.skill_catalog}\"]}";
        ApiRequestValidator.Result result = validator.validate("openai-chat-completions", 1, source);
        assertFalse(result.valid(), "context-block slots must not masquerade as tool slots");
    }
}
