package com.cc01cc.p.xihe.cp.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * PLAN-0629 M1 (D29-33): the dedupe contract — "the same assertion" is defined by this normalizer, so
 * its rules are pinned here rather than inferred from a passing service test.
 */
class AgentMemoryNormalizerTest {

    @Test
    void composesUnicodeTrimsAndCollapsesWhitespace() {
        assertEquals("hello world", AgentMemoryNormalizer.normalize("  hello   world \n"));
        // NFC: "e" + combining acute and the precomposed "é" are the same assertion.
        assertEquals("é", AgentMemoryNormalizer.normalize("e\u0301"));
        assertEquals(AgentMemoryNormalizer.normalize("café"), AgentMemoryNormalizer.normalize("cafe\u0301"));
        // Newlines are whitespace: a memory is one assertion, not a document.
        assertEquals("a b", AgentMemoryNormalizer.normalize("a\n\nb"));
    }

    @Test
    void dropsZeroWidthCharactersAndRecollapses() {
        assertEquals("ab", AgentMemoryNormalizer.normalize("a\u200Bb"));
        assertEquals("a b", AgentMemoryNormalizer.normalize("a\u200B b"),
                "removing the zero-width character may leave two spaces — they collapse again");
        assertEquals("hello", AgentMemoryNormalizer.normalize("\uFEFFhello\u200D"));
    }

    @Test
    void preservesCase() {
        assertEquals("Fact", AgentMemoryNormalizer.normalize("Fact"));
        assertNotEquals(AgentMemoryNormalizer.normalize("Fact"), AgentMemoryNormalizer.normalize("fact"),
                "the ruling rejected case folding: it would change what a fact means");
    }

    @Test
    void blanksNormalizeToEmpty() {
        assertEquals("", AgentMemoryNormalizer.normalize(null));
        assertEquals("", AgentMemoryNormalizer.normalize("   \n\t "));
        assertEquals("", AgentMemoryNormalizer.normalize("\u200B\u200B"));
    }

    @Test
    void hashesTheNormalizedTextAsLowercaseHexSha256() {
        assertEquals("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                AgentMemoryNormalizer.sha256Hex("hello"));
        assertEquals(64, AgentMemoryNormalizer.sha256Hex("hello").length());
        // The hash is taken over the normalized form: visually identical input collides on purpose.
        assertEquals(AgentMemoryNormalizer.sha256Hex(AgentMemoryNormalizer.normalize("  hello  ")),
                AgentMemoryNormalizer.sha256Hex(AgentMemoryNormalizer.normalize("hello")));
    }
}
