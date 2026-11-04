package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;

/**
 * 名称格式规则（用户 2026-11-03 裁定 v23 + 2026-11-04 裁定 v29）：<b>agent 主体名</b>、
 * <b>username</b> 与<b>昵称（= 现状 displayName）</b>不得含空格，只允许英文字母 / 中文汉字 /
 * 数字，且不得以数字开头。v29 把这条规则补全到全部名称面：昵称不新增独立字段，人的
 * displayName 就是 username、agent 的 displayName 就是主体名。
 *
 * <p>单一事实源：写入口只调用 {@link #require(String, String)}（agent 名）或
 * {@link #isValidUsername(String)}（username 面，既有错误码 {@code USERNAME_INVALID} 不变），
 * 不要在各 controller/service 里各写一份正则——否则同一条规则会漂出两套错误码与两套文案。
 * OpenAPI 的 {@code pattern} 由 {@link #PATTERN_SOURCE} 手工同步（同一字符串，openapi 无法
 * import 常量）。</p>
 *
 * <p>maxLength 因面而异：{@code agent_principals.name} 是 TEXT（列宽不设限，代码上限 64），
 * {@code users.username} 是 {@code VARCHAR(32)}（V82），故 {@link #USERNAME_MAX_LENGTH} = 32。
 * 两个上限都留在这里，调用点不得自己写字面量。</p>
 *
 * <p>为什么不是 bean validation 注解：agent principal 的创建/更新入口消费的是
 * {@code Map<String, Object>}（无 DTO），{@code @Pattern} 无处可挂；而 {@code @Valid} 校验失败
 * 会落到 {@code ProblemDetailsHandler} 的泛化 400（{@code INVALID_REQUEST}），与裁决要求的
 * 专用错误码冲突。故统一在 service 层判定，DTO 存在处（member add）也只保留这一处判定。</p>
 */
public final class NameFormat {

    /** 允许：英文字母 / 中文汉字（U+4E00–U+9FFF）/ 数字；首字符不得是数字。 */
    public static final String PATTERN_SOURCE = "^[A-Za-z\\u4e00-\\u9fff][A-Za-z0-9\\u4e00-\\u9fff]*$";

    /** 专用错误码（不得回落到泛化 {@code INVALID_REQUEST}）。 */
    public static final String CODE = "INVALID_NAME_FORMAT";

    /** {@code agent_principals.name} 的代码上限（列类型 TEXT，V42）。 */
    public static final int MAX_LENGTH = 64;

    /**
     * {@code users.username} 的列宽（{@code VARCHAR(32)}，V82）。v29 之后 username 与主体名
     * 共用同一 pattern，只有长度比我不同。
     */
    public static final int USERNAME_MAX_LENGTH = 32;

    private static final Pattern COMPILED = Pattern.compile(PATTERN_SOURCE);

    private NameFormat() {}

    /** 纯判定，供既有校验分支复用；{@code null} 视为不合法。 */
    public static boolean isValid(String value) {
        return value != null && COMPILED.matcher(value).matches();
    }

    /**
     * username 面的纯判定：同一 pattern + 列宽上限。注册/建号面**保留既有错误码**
     * {@code USERNAME_INVALID}（决策 D61-05 暂定 (ii)，客户端契约不变），故这里只给布尔值，
     * 由 {@code AuthService} / {@code UserAdminService} 自己抛既有错误。
     */
    public static boolean isValidUsername(String value) {
        return isValid(value) && value.length() <= USERNAME_MAX_LENGTH;
    }

    /**
     * 校验并原样返回：<b>不 trim、不改写</b>（含空格即不合法，静默 trim 会掩盖前导/尾随空格）。
     *
     * @param value 待校验值
     * @param field 出现在错误信息里的字段名（如 {@code name} / {@code username}）
     */
    public static String require(String value, String field) {
        return require(value, field, MAX_LENGTH);
    }

    /**
     * 同上，但长度上限由调用面给定（目前只有 username 面需要 32，见 {@link #USERNAME_MAX_LENGTH}）。
     *
     * @param value     待校验值
     * @param field     出现在错误信息里的字段名
     * @param maxLength 该面的长度上限
     */
    public static String require(String value, String field, int maxLength) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, CODE,
                    field + " must not be blank");
        }
        if (value.length() > maxLength) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, CODE,
                    field + " must be at most " + maxLength + " characters");
        }
        if (!COMPILED.matcher(value).matches()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, CODE,
                    field + " must start with a letter or Chinese character and contain only "
                            + "letters, digits and Chinese characters (no spaces or symbols)");
        }
        return value;
    }
}
