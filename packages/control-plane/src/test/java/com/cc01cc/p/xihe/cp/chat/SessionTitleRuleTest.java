package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * D-1866 / task-24: the pure rule. No Spring, no DB, no provider — if this class ever needs a
 * context the "zero model calls" guarantee has already been broken.
 */
class SessionTitleRuleTest {

    @Test
    void derive_stripsHeadingMarkers() {
        assertEquals("部署脚本怎么跑", SessionTitleRule.derive("## 部署脚本怎么跑"));
        assertEquals("标题", SessionTitleRule.derive("#标题"));
        assertEquals("四级标题", SessionTitleRule.derive("#### 四级标题 ####"));
    }

    @Test
    void derive_stripsInlineEmphasisCodeAndStrikethrough() {
        assertEquals("加粗 和 斜体 和 code", SessionTitleRule.derive("**加粗** 和 *斜体* 和 `code`"));
        assertEquals("删除线", SessionTitleRule.derive("~~删除线~~"));
        assertEquals("snake_case 保持原样", SessionTitleRule.derive("snake_case 保持原样"));
    }

    @Test
    void derive_stripsQuotesListsAndTaskItems() {
        assertEquals("引用内容", SessionTitleRule.derive("> 引用内容"));
        assertEquals("第一项", SessionTitleRule.derive("- 第一项"));
        assertEquals("第二项", SessionTitleRule.derive("1. 第二项"));
        assertEquals("待办", SessionTitleRule.derive("- [ ] 待办"));
    }

    @Test
    void derive_replacesLinksAndImagesWithTheirText() {
        assertEquals("文档 说明", SessionTitleRule.derive("[文档](https://example.com/a) 说明"));
        assertEquals("截图", SessionTitleRule.derive("![截图](https://example.com/y.png)"));
        assertEquals("标题", SessionTitleRule.derive("<div>标题</div>"));
    }

    @Test
    void derive_foldsNewlinesAndRepeatedWhitespaceToSingleSpaces() {
        assertEquals("第一行 第二行 第三行", SessionTitleRule.derive("第一行\n\n  第二行\t第三行"));
        assertEquals("a b", SessionTitleRule.derive("  a \n b  "));
    }

    @Test
    void derive_truncatesTo24UnitsWithEllipsis() {
        String derived = SessionTitleRule.derive("中".repeat(30));
        assertEquals("中".repeat(24) + "\u2026", derived);
        assertEquals(25, derived.length());
    }

    @Test
    void derive_keepsExactly24UnitsWithoutEllipsis() {
        assertEquals("中".repeat(24), SessionTitleRule.derive("中".repeat(24)));
    }

    @Test
    void derive_neverSplitsSurrogatePairsOrEmojiSequences() {
        // Acceptance ④: CJK + emoji truncation must not cut a character in half.
        String[] samples = {
            "\uD83D\uDC4D",                       // 👍 single code point
            "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67", // 👨‍👩‍👧 ZWJ family
            "\uD83C\uDDE8\uD83C\uDDF3",          // 🇨🇳 regional indicator pair
            "\uD83E\uDD26\uD83C\uDFFD\u200D\u2642\uFE0F", // 🤦🏽‍♂️ skin tone + ZWJ
            "\u4E2D",                              // 中
        };
        for (String sample : samples) {
            String derived = SessionTitleRule.derive(sample.repeat(30));
            assertNoLoneSurrogate(derived);
            assertFalse(derived.endsWith("\u200D"), "dangling joiner in " + derived);
            assertTrue(derived.endsWith(SessionTitleRule.ELLIPSIS), "expected ellipsis for " + derived);
        }
    }

    @Test
    void derive_countsOneEmojiAsOneUnit() {
        assertEquals("\uD83D\uDC4D".repeat(24) + "\u2026",
                SessionTitleRule.derive("\uD83D\uDC4D".repeat(25)));
    }

    @Test
    void derive_returnsEmptyForPureMarkdown() {
        // Acceptance ③: pure markers must not become a title (the caller keeps the default).
        for (String markersOnly : new String[] {"###", "***", "- - -", "> > >", "```", "---", "|||", "**", "~~~"}) {
            assertEquals("", SessionTitleRule.derive(markersOnly), "expected empty for: " + markersOnly);
        }
    }

    @Test
    void derive_returnsEmptyForBlankInput() {
        assertEquals("", SessionTitleRule.derive(null));
        assertEquals("", SessionTitleRule.derive(""));
        assertEquals("", SessionTitleRule.derive("   \n\t "));
    }

    @Test
    void derive_capsTheScannedHeadSoHugeMessagesStayCheap() {
        String derived = SessionTitleRule.derive("头".repeat(200_000) + "\n\n尾部");
        assertEquals("头".repeat(24) + "\u2026", derived);
    }

    @Test
    void isDefaultTitle_recognisesEveryClientDefault() {
        for (String defaultTitle : SessionTitleRule.DEFAULT_TITLES) {
            assertTrue(SessionTitleRule.isDefaultTitle(defaultTitle), defaultTitle);
        }
        assertTrue(SessionTitleRule.isDefaultTitle(null));
        assertTrue(SessionTitleRule.isDefaultTitle(""));
        assertTrue(SessionTitleRule.isDefaultTitle("   "));
    }

    @Test
    void isDefaultTitle_treatsAnyOtherTitleAsManualRename() {
        // Hard constraint ①: anything that is not a known default wins forever, including a
        // case/whitespace variant the user typed on purpose.
        assertFalse(SessionTitleRule.isDefaultTitle("我的会话"));
        assertFalse(SessionTitleRule.isDefaultTitle("untitled"));
        assertFalse(SessionTitleRule.isDefaultTitle("Untitled session 2"));
        assertFalse(SessionTitleRule.isDefaultTitle("部署脚本怎么跑"));
    }

    private static void assertNoLoneSurrogate(String text) {
        for (int index = 0; index < text.length(); index++) {
            char current = text.charAt(index);
            if (Character.isHighSurrogate(current)) {
                assertTrue(index + 1 < text.length() && Character.isLowSurrogate(text.charAt(index + 1)),
                        "lone high surrogate at " + index + " in " + text);
                index++;
            } else {
                assertFalse(Character.isLowSurrogate(current),
                        "lone low surrogate at " + index + " in " + text);
            }
        }
    }
}
