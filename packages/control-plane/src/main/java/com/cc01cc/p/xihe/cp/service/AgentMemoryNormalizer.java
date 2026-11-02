package com.cc01cc.p.xihe.cp.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * PLAN-0629 M1 (D29-33): the <b>single</b> place that decides what "the same memory" means.
 *
 * <p>Dedupe is {@code (type, sha256(normalized content))}, so the normalisation rule is a contract,
 * not an implementation detail — two visually identical strings must hash identically, and two
 * different assertions must never collide. The frozen rule (user ruling 2026-11-02) is:</p>
 *
 * <ol>
 *   <li>Unicode <b>NFC</b> (composed form — the same text typed on macOS and Windows must agree);</li>
 *   <li><b>trim</b> leading/trailing whitespace;</li>
 *   <li><b>collapse</b> internal whitespace runs to a single space (newlines included: a memory is one
 *       assertion, not a document);</li>
 *   <li><b>drop zero-width characters</b> ({@code U+200B..U+200D}, {@code U+FEFF}) — invisible
 *       characters would otherwise let one assertion masquerade as many;</li>
 *   <li>after removing zero-width characters, collapse whitespace <b>once more</b>, because the
 *       removal can leave two spaces adjacent ({@code "a\u200B b"} → {@code "a  b"} without it);</li>
 *   <li><b>case is preserved</b> — the ruling rejected case folding because it would change what a
 *       {@code fact} means ("Fact" and "fact" can be different assertions).</li>
 * </ol>
 *
 * <p>{@code content_sha256} is always produced here, from the normalised text, over UTF-8 bytes, as
 * lowercase hex. Never accept a hash from a caller: a client-supplied hash would silently defeat the
 * dedupe uniqueness and could point two different texts at one row.</p>
 */
public final class AgentMemoryNormalizer {

    private static final Pattern WHITESPACE = Pattern.compile("\\s+");
    private static final Pattern ZERO_WIDTH = Pattern.compile("[\\u200B-\\u200D\\uFEFF]");
    private static final HexFormat HEX = HexFormat.of();

    private AgentMemoryNormalizer() {}

    /** @return the canonical stored form; empty when the input carries no visible character */
    public static String normalize(String content) {
        if (content == null) {
            return "";
        }
        String composed = Normalizer.normalize(content, Normalizer.Form.NFC);
        String collapsed = collapse(composed.strip());
        String withoutInvisible = ZERO_WIDTH.matcher(collapsed).replaceAll("");
        return collapse(withoutInvisible);
    }

    /**
     * @param normalized the output of {@link #normalize(String)} — the caller must not hash the raw text
     * @return lowercase hex SHA-256 of the UTF-8 bytes
     */
    public static String sha256Hex(String normalized) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HEX.formatHex(digest.digest(normalized.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is mandatory for every JVM; reaching here means a broken runtime, not bad input.
            throw new IllegalStateException("SHA-256 is unavailable in this JVM", e);
        }
    }

    private static String collapse(String value) {
        return WHITESPACE.matcher(value).replaceAll(" ").strip();
    }
}
