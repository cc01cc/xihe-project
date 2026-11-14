package com.cc01cc.p.xihe.cp.policy;

import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Q-d 双键资源标识（task-521）。
 *
 * <p><b>声明键</b> {@code fs:<rootScopeId>/<rel>}：可审计、可落 grant 行；不含宿主绝对路径。
 * <b>求交键</b> {@code phys:<归一化绝对路径>}：只在求值期构造，<b>不写回 grant 行</b> ——
 * 工作区搬家后缓存的 phys 会过期，等于又一处「过期即丢」（V160:4-10 已踩过）。
 * 两键共用 {@link PathKey} 这一个 normalize 入口，禁止各写一份（501 §10.3 第 1 条）。</p>
 *
 * <p>七条禁令（501 §10.4）与落点：①目录资源不得进冻结快照（本类只服务 grants 行）；
 * ②不把宿主绝对路径存成声明串（声明键永不含绝对路径，phys 只作求值键）；
 * ③授权面不解析符号链接（逃逸由执行面 {@code fs.rs} 拒绝，本类只做词法层）；
 * ④拒绝 {@code ..}/{@code .}/UNC/{@code \\?\} 前缀（{@link #parseDeclaration} fail-closed）；
 * ⑤不用 glob 作授权单位（含 {@code *} 的 rel 不算声明，交回调用方）；
 * ⑥实例级 rel 必带盘符段、工作区级 rel 不得带（{@link #physicalKeyOf}）；
 * ⑦<b>求交不得退化成字符串相等</b>（{@link #matchesDeclaration}：解析不出 phys 就拒绝）。</p>
 */
public final class ResourceIdentity {

    public static final String DECLARATION_PREFIX = "fs:";
    public static final String PHYSICAL_PREFIX = "phys:";

    /** 盘符段：{@code D:} 或 {@code D:/...}。 */
    private static final Pattern DRIVE_SEGMENT = Pattern.compile("^[A-Za-z]:(/.*)?$");

    public enum ScopeKind { INSTANCE, WORKSPACE }

    /** 声明键：命名空间 id + 相对路径（空串 = 该作用域根本身）。 */
    public record FsKey(String rootScopeId, String relativePath) {}

    /** 作用域解析结果：实例根 = 盘符根；工作区根 = 已存的 workspace hostPath。 */
    public record RootScope(ScopeKind kind, String absoluteRootPath) {}

    private ResourceIdentity() {}

    /**
     * 解析声明键。不是 {@code fs:} 形态、结构坏、含 glob / 反斜杠 / 点段 / UNC / 长路径前缀
     * ⇒ {@code null}（fail-closed，调用方按「非声明键」处理）。
     */
    public static FsKey parseDeclaration(String raw) {
        if (raw == null) {
            return null;
        }
        String value = raw.trim();
        if (!value.startsWith(DECLARATION_PREFIX)) {
            return null;
        }
        String rest = value.substring(DECLARATION_PREFIX.length());
        int slash = rest.indexOf('/');
        String rootScopeId = slash < 0 ? rest : rest.substring(0, slash);
        String relative = slash < 0 ? "" : rest.substring(slash + 1);
        if (rootScopeId.isBlank()) {
            return null;
        }
        if (relative.indexOf('*') >= 0 || relative.indexOf('\\') >= 0) {
            return null;
        }
        if (relative.startsWith("/") || PathKey.isUncOrExtended(relative)
                || PathKey.hasDotSegments(relative)) {
            return null;
        }
        while (relative.endsWith("/")) {
            relative = relative.substring(0, relative.length() - 1);
        }
        return new FsKey(rootScopeId, relative);
    }

    /** 绝对路径 → {@code phys:} 键（唯一 normalize 入口是 {@link PathKey#phys(String)}）。 */
    public static String physicalKey(String absolutePath) {
        return PathKey.phys(absolutePath);
    }

    /**
     * 声明键 → {@code phys:} 键。实例级 rel 必须自带盘符段并直接作绝对路径；工作区级 rel 相对
     * 工作区根拼接。作用域未知、盘符段规则不符、路径不可词法化 ⇒ {@code null}。
     */
    public static String physicalKeyOf(FsKey key, RootScope scope) {
        if (key == null || scope == null) {
            return null;
        }
        String root = scope.absoluteRootPath();
        if (root == null || root.isBlank()) {
            return null;
        }
        String relative = key.relativePath() == null ? "" : key.relativePath();
        boolean driveInRelative = DRIVE_SEGMENT.matcher(relative).matches();
        if (scope.kind() == ScopeKind.INSTANCE) {
            // ⑥ 实例级 rel 必带盘符段，且它本身就是绝对路径。
            return driveInRelative ? physicalKey(relative) : null;
        }
        // ⑥ 工作区级 rel 不得含盘符段。
        if (driveInRelative) {
            return null;
        }
        String absolute = relative.isEmpty() ? root : root + "/" + relative;
        return physicalKey(absolute);
    }

    /**
     * 两条声明键是否指向同一目录（相等或授予根包含请求）。
     *
     * @return {@code null} = 这一对不构成「双 {@code fs:} 声明键」（调用方按原匹配器处理，{@code *}
     *     仍走通配）；{@code false} = 有一侧是声明键但解析不出 phys ⇒ <b>拒绝</b>，
     *     <b>绝不回退成字符串比较</b>（501 §10.4 第 7 条）。
     */
    public static Boolean matchesDeclaration(String grantResource, String requestResource,
            Function<String, RootScope> scopes) {
        FsKey grantKey = parseDeclaration(grantResource);
        FsKey requestKey = parseDeclaration(requestResource);
        if (grantKey == null && requestKey == null) {
            return null;
        }
        if (grantKey == null) {
            // 通配授予仍在原匹配器里处理；其它非声明形态与声明键不可比 ⇒ 拒绝。
            return "*".equals(grantResource) ? null : Boolean.FALSE;
        }
        if (requestKey == null || scopes == null) {
            return Boolean.FALSE;
        }
        String grantPhysical = strip(physicalKeyOf(grantKey, scopes.apply(grantKey.rootScopeId())));
        String requestPhysical = strip(physicalKeyOf(requestKey, scopes.apply(requestKey.rootScopeId())));
        if (grantPhysical == null || requestPhysical == null) {
            return Boolean.FALSE;
        }
        return PathKey.withinLexical(requestPhysical, grantPhysical);
    }

    private static String strip(String physicalKey) {
        if (physicalKey == null) {
            return null;
        }
        return physicalKey.startsWith(PHYSICAL_PREFIX)
                ? physicalKey.substring(PHYSICAL_PREFIX.length())
                : physicalKey;
    }
}
