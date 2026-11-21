package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-18 J4 (gap B): the first-run subjects' model intent is resolved from what the provider catalog
 * declares, and an entry that declares nothing yields the "待绑定" intent instead of a literal name.
 *
 * <p>The shipped catalog is the negative case (no provider entry carries model ids — {@code ollama} is
 * {@code modelDiscovery=remote-models}), so the positive cases below use synthetic entries to pin the
 * reader itself: a future catalog that does declare ids must bind them without code changes.</p>
 */
class FirstRunSeedModelIntentTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void theShippedCatalogDeclaresNoModelIdsForOllama() throws Exception {
        JsonNode ollama = mapper.readTree("""
                {"id":"ollama","modelDiscovery":"remote-models",
                 "supportedApiTypes":[{"apiTypeId":"openai-chat-completions","version":1}]}
                """);

        assertTrue(FirstRunSeedModelIntent.modelIds(ollama).isEmpty(),
                "ollama's real entry carries no model ids, so nothing is resolvable at first run");
        FirstRunSeedModelIntent.Intent intent = FirstRunSeedModelIntent.resolve("ollama", ollama);
        assertTrue(intent.pendingBinding(), "the honest answer is 待绑定");
        assertNull(intent.provider(), "provider stays empty so the API stays valid (both-or-neither)");
        assertNull(intent.model());
    }

    @Test
    void readsModelIdsFromEveryPositionTheCatalogMayUse() throws Exception {
        JsonNode entry = mapper.readTree("""
                {"id":"vendor",
                 "models":["b-model",{"id":"a-model"},{"model":"c-model"},{"name":"d-model"}],
                 "defaultModel":"e-model",
                 "supportedApiTypes":[{"apiTypeId":"x","version":1,"models":["f-model"]}]}
                """);

        assertEquals(List.of("a-model", "b-model", "c-model", "d-model", "e-model", "f-model"),
                List.copyOf(FirstRunSeedModelIntent.modelIds(entry)),
                "ids are collected from models[]/defaultModel/supportedApiTypes[].models and sorted");
    }

    @Test
    void picksTheFirstDeclaredIdDeterministicallyAndKeepsTheProvider() throws Exception {
        JsonNode entry = mapper.readTree("{\"models\":[\"zeta:7b\",\"alpha:1b\"]}");

        FirstRunSeedModelIntent.Intent intent = FirstRunSeedModelIntent.resolve("vendor", entry);

        assertTrue(!intent.pendingBinding());
        assertEquals("vendor", intent.provider());
        assertEquals("alpha:1b", intent.model(), "sorted pick: same catalog always resolves the same id");
    }

    @Test
    void aBlankOrMissingEntryIsPendingRatherThanAProviderWithoutAModel() throws Exception {
        assertTrue(FirstRunSeedModelIntent.resolve("  ", mapper.readTree("{}")).pendingBinding());
        assertTrue(FirstRunSeedModelIntent.resolve(null, mapper.readTree("{\"models\":[\"m\"]}"))
                .pendingBinding());
        assertTrue(FirstRunSeedModelIntent.resolve("vendor", null).pendingBinding());
    }
}
