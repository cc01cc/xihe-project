package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-104（task-87 测试轮，判据 1/2）：{@code AgentPrincipalService.grantSources(rows, expanded)}
 * —— the wire {@code provenance.grantSources} map.
 *
 * <p>Why a plain JUnit test on this seam: {@code grantSources} is package-private on purpose (the
 * javadoc says so) because the wire cannot produce a null-id row without an org-unit binding, so
 * "skip the synthetic row" is only observable at the seam. Same reason the task-57 regression lives
 * on this class: a 200 with a NPE-free body proves nothing about which ids were dropped.</p>
 *
 * <p>Three assertions carry the contract and are deliberately mechanical:</p>
 * <ol>
 *   <li>label of a persisted row == its own {@code source} (never a default such as {@code role});</li>
 *   <li>an out-of-vocabulary source answers {@code unknown} — not a relabel;</li>
 *   <li>the key set == the union of both id lists with null ids dropped (contract: "covers EXACTLY
 *       the union of principalGrantIds and bindingGrantIds"; missing key = unlabelled row, extra key
 *       = drift).</li>
 * </ol>
 */
class AgentPrincipalServiceGrantSourcesTest {

    /** 每一条 {@code EVALUATION_SOURCES}（V139 {@code ck_grants_source} 的六个持久化取值）逐一对齐。 */
    static Stream<String> persistedSources() {
        return GrantSources.EVALUATION_SOURCES.stream();
    }

    @ParameterizedTest(name = "source={0} keeps its own label")
    @MethodSource("persistedSources")
    void persistedRowKeepsItsOwnLabel(String source) {
        UUID id = UUID.randomUUID();
        Map<String, String> labels = AgentPrincipalService.grantSources(List.of(row(source, id)), List.of());

        assertEquals(Map.of(id.toString(), source), labels,
                "a persisted row must be labelled with its own source, never with a fallback");
    }

    /**
     * {@code org_unit} 目前线上不可达（合成行 id 恒 null ⇒ 键不进来），但词表故意保留它：将来若有
     * 落库的 org-unit 行，标签必须就是 {@code org_unit}，不能被降级成 {@code unknown} 或 {@code role}。
     * 这条用例把「词表可达性」与「id 可键性」分成两件事分别钉住。
     */
    @Test
    void orgUnitLabelIsPreservedWhenSuchARowEverCarriesAnId() {
        UUID id = UUID.randomUUID();
        Map<String, String> labels = AgentPrincipalService.grantSources(List.of(row(GrantSources.ORG_UNIT, id)), List.of());

        assertEquals(Map.of(id.toString(), GrantSources.ORG_UNIT), labels);
    }

    /** 词表外取值（含 {@code session_temp}：它永不进 {@code grants}）一律 {@code unknown}，不回落 role。 */
    @Test
    void outOfVocabularyAndNullSourcesAnswerUnknown() {
        UUID unknownId = UUID.randomUUID();
        UUID tempId = UUID.randomUUID();
        UUID nullId = UUID.randomUUID();
        Map<String, String> labels = AgentPrincipalService.grantSources(
                List.of(row("mystery", unknownId), row(GrantSources.SESSION_TEMP, tempId),
                        row(null, nullId)), List.of());

        assertEquals(GrantSources.UNKNOWN, labels.get(unknownId.toString()));
        assertEquals(GrantSources.UNKNOWN, labels.get(tempId.toString()));
        assertEquals(GrantSources.UNKNOWN, labels.get(nullId.toString()));
        assertEquals(3, labels.size());
        assertFalse(labels.containsValue(GrantSources.PRESET),
                "unknown 必须是 unknown，不是任何真实来源的默认回落");
    }

    /** 两个列表都空 ⇒ 空 map 且非 null（wire 上恒发、空集是 {@code {}} 的契约起点）。 */
    @Test
    void emptyListsAnswerEmptyMapNotNull() {
        Map<String, String> labels = AgentPrincipalService.grantSources(List.of(), List.of());

        assertNotNull(labels, "契约：grantSources 恒在，空态是 {}，不是 null");
        assertTrue(labels.isEmpty());
    }

    /**
     * null-id 跳过（与 task-57 互相印证）：org-unit 合成行 id 恒 null（{@code @PrePersist} 才填），
     * 不能作为 map 的键 ⇒ 整行缺席；同批里 id 非空的兄弟行必须照常出现（否则「跳过」可能是「全丢」）。
     */
    @Test
    void nullIdRowIsSkippedWhileSiblingsSurvive() {
        UUID kept = UUID.randomUUID();
        Map<String, String> labels = AgentPrincipalService.grantSources(
                List.of(row(GrantSources.PRESET, null), row(GrantSources.TEMPLATE, kept)),
                List.of(row(GrantSources.ORG_UNIT, null)));

        assertEquals(Map.of(kept.toString(), GrantSources.TEMPLATE), labels);
        assertEquals(1, labels.size(), "null-id 合成行不得贡献任何键");
    }

    /** 同一行同时出现在 rows 与 expanded（合并后的并集）⇒ 一个键、首个标签胜出，键集不翻倍。 */
    @Test
    void duplicateRowKeepsOneKeyFirstLabelWins() {
        UUID id = UUID.randomUUID();
        Map<String, String> labels = AgentPrincipalService.grantSources(
                List.of(row(GrantSources.PRESET, id)), List.of(row(GrantSources.TEMPLATE, id)));

        assertEquals(Map.of(id.toString(), GrantSources.PRESET), labels);
        assertEquals(1, labels.size());
    }

    /**
     * 判据 2（双向键集）：key 集 == {@code principalGrantIds ∪ bindingGrantIds} 去 null 后的集合。
     * 期望值在测试里独立算（不复用生产代码的派生），两侧各含一条 null-id 行 —— 只要哪一侧多出一个键
     * 或漏掉一个键，这条断言都会红。
     */
    @Test
    void keySetEqualsTheUnionOfBothIdListsDroppingNullIds() {
        UUID principalA = UUID.randomUUID();
        UUID principalB = UUID.randomUUID();
        UUID bindingA = UUID.randomUUID();
        List<AuthorizationGrant> rows = List.of(row(GrantSources.PRESET, principalA),
                row(GrantSources.AGENT_DEFAULT, principalB), row(GrantSources.PRESET, null));
        List<AuthorizationGrant> expanded = List.of(row(GrantSources.ORG_UNIT, null),
                row(GrantSources.SPAWN, bindingA));

        Map<String, String> labels = AgentPrincipalService.grantSources(rows, expanded);

        Set<String> expected = new LinkedHashSet<>();
        expected.add(principalA.toString());
        expected.add(principalB.toString());
        expected.add(bindingA.toString());
        assertEquals(expected, labels.keySet(),
                "grantSources 的键集必须恰好是两数组去 null 后的并集（缺键=漏标、多键=drift）");
        assertEquals(3, labels.size());

        // 值域封闭：map 只会发出词表内的标签或 unknown，不会是原始 source 字符串。
        Set<String> vocabulary = new LinkedHashSet<>(GrantSources.PROVENANCE_SOURCES);
        vocabulary.add(GrantSources.UNKNOWN);
        assertTrue(vocabulary.containsAll(labels.values()),
                () -> "labels escaped the vocabulary: " + labels.values());
    }

    private static AuthorizationGrant row(String source, UUID id) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(id);
        grant.setSource(source);
        return grant;
    }
}
