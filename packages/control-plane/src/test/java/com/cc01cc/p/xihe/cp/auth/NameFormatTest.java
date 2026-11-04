package com.cc01cc.p.xihe.cp.auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * 名称格式规则（用户 2026-11-03 裁定）的单点门：agent 主体名与 username 只允许
 * 字母/汉字/数字，且首字符不得是数字；不得含空格与符号。
 *
 * <p>纯单元测试：不连库、不起 Spring（规则是纯函数，这里只钉规则本身）。路由级行为
 * （principal 创建 400 {@code INVALID_NAME_FORMAT}、member add 用户名非法）由各自的
 * integration/contract 测试覆盖。</p>
 */
class NameFormatTest {

    @ParameterizedTest
    @ValueSource(strings = {"Zoe", "zoe", "张三", "zoe2026", "Agent2", "李明2", "中", "a"})
    void accepts_letters_chinese_and_digits_without_leading_digit(String value) {
        assertTrue(NameFormat.isValid(value), value + " should be a valid name");
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "1Zoe",          // 数字开头
            "123",
            " zoe",          // 前导空格（含空格）
            "zoe ",          // 尾随空格
            "zoe wang",      // 中间空格
            "张 三",
            "zoe_wang",      // 下划线
            "zoe-wang",      // 连字符
            "zoe.wang",      // 点
            "zoe@example",   // @
            "张三（PM）",     // 中文括号
            "Zoë",           // 非 ASCII 字母（不在允许集内）
            ""
    })
    void rejects_leading_digit_spaces_and_symbols(String value) {
        assertFalse(NameFormat.isValid(value), value + " should be rejected");
    }

    @Test
    void require_throws_the_dedicated_code_not_the_generic_bad_request() {
        CpApiException thrown = assertThrows(CpApiException.class,
                () -> NameFormat.require("zoe wang", "name"));
        assertEquals(NameFormat.CODE, thrown.getCode());
        assertEquals(400, thrown.getStatus().value());
        assertTrue(thrown.getMessage().contains("name"));
    }

    @Test
    void require_rejects_blank_and_null_with_the_same_code() {
        assertEquals(NameFormat.CODE,
                assertThrows(CpApiException.class, () -> NameFormat.require("", "username")).getCode());
        assertEquals(NameFormat.CODE,
                assertThrows(CpApiException.class, () -> NameFormat.require(null, "username")).getCode());
    }

    @Test
    void require_rejects_overlong_names() {
        String tooLong = "a".repeat(NameFormat.MAX_LENGTH + 1);
        assertEquals(NameFormat.CODE,
                assertThrows(CpApiException.class, () -> NameFormat.require(tooLong, "name")).getCode());
    }

    @Test
    void require_returns_the_value_unchanged() {
        // 不做 trim / 正规化：写入口拿到的就是原值，静默改写会把「含空格」这条规则弄丢。
        assertEquals("张三", NameFormat.require("张三", "name"));
        assertEquals("Zoe2026", NameFormat.require("Zoe2026", "username"));
    }
}
