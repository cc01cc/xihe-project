package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRootRepository;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import org.springframework.stereotype.Component;

import java.util.Optional;
import java.util.UUID;

/**
 * Q-d 声明键生产者（task-533）：把真实路径变成 {@code fs:<workspaceId>/<rel>}。
 *
 * <p>根一律来自<b>已存</b>的 workspace 行（501 §10.3 第 2 条），不由请求方传入；声明键里
 * <b>不含宿主绝对路径</b>（§10.4 第 2 条），相对路径由 {@link PathKey#lexical} 归一后再切。</p>
 *
 * <p><b>已知边界（不自行扩权）</b>：①声明键形态只编码<b>一个</b>根，二级根路径今天无法表达 ⇒
 * fail-closed 返回 null；②实例级作用域缺锚点（没有实例根这一行）⇒ {@link #scopeFor} 返回 null，
 * 实例级声明键在求交时按拒绝处理（与 521 的 fail-closed 一致）。两处都需单独裁定后再扩。</p>
 */
@Component
public class FsResourceKeys {

    private final WorkspaceRepository workspaces;
    private final WorkspaceRootRepository roots;

    public FsResourceKeys(WorkspaceRepository workspaces, WorkspaceRootRepository roots) {
        this.workspaces = workspaces;
        this.roots = roots;
    }

    /**
     * 纯函数：路径落在给定根之内 ⇒ 声明键；不在根内、含点段、含盘符段残片 ⇒ {@code null}。
     *
     * <p>{@code roots} 字段今天不参与主根换算，保留给二级根扩展时使用。</p>
     */
    public static String declarationKey(String workspaceId, String rootHostPath, String candidatePath) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return null;
        }
        String root = PathKey.lexical(rootHostPath);
        String candidate = PathKey.lexical(candidatePath);
        if (root == null || candidate == null || !PathKey.withinLexical(candidate, root)) {
            return null;
        }
        String relative = candidate.equals(root) ? "" : candidate.substring(root.length() + 1);
        if (relative.indexOf(':') >= 0) {
            return null;
        }
        String key = ResourceIdentity.DECLARATION_PREFIX + workspaceId.trim();
        return relative.isEmpty() ? key : key + "/" + relative;
    }

    /** task-81/G-2：相对路径形态的长度上限（提取器本身限 2048，这里更紧）。 */
    private static final int MAX_RELATIVE_LENGTH = 1024;

    /**
     * 纯函数（task-81 / G-2）：把<b>工作区相对路径</b>换算成声明键。
     *
     * <p>{@link #declarationKey} 要求候选人已是宿主绝对路径且落在根内，但工具实际收到的是相对路径
     * （{@code read_file {"path":"src/a.ts"}}）。这里只做保守形状校验（{@link #plainRelative}），
     * 合法即拼进同一个 {@code fs:<workspaceId>} 命名空间：相对路径按定义就在根内，不必再走一次
     * {@code withinLexical}。形状不合法 ⇒ {@code null}，调用方保留原串 —— 求交侧对非声明键返回
     * 拒绝（fail-closed），{@code HardGuard} 也仍能看到原始 {@code ..} 并硬拒。</p>
     */
    public static String declarationKeyFromRelative(String workspaceId, String rootHostPath,
                                                    String relativePath) {
        if (workspaceId == null || workspaceId.isBlank() || PathKey.lexical(rootHostPath) == null) {
            return null;
        }
        String relative = plainRelative(relativePath);
        if (relative == null) {
            return null;
        }
        // plainRelative 已保证非空 ⇒ 相对形态永远带段，不存在裸 fs:<wsId> 的分支。
        return ResourceIdentity.DECLARATION_PREFIX + workspaceId.trim() + "/" + relative;
    }

    /**
     * 保守的相对路径形状：归一化分隔符后不得有盘符/协议冒号、通配符、UNC、点段或空段。
     *
     * @return 归一化后的相对路径；不合法为 {@code null}（fail-closed）
     */
    static String plainRelative(String raw) {
        if (raw == null) {
            return null;
        }
        String value = raw.trim().replace('\\', '/');
        if (value.isEmpty() || value.length() > MAX_RELATIVE_LENGTH || value.startsWith("/")) {
            return null;
        }
        if (value.indexOf(':') >= 0 || value.indexOf('*') >= 0 || value.indexOf('?') >= 0) {
            return null;
        }
        if (PathKey.isUncOrExtended(value) || PathKey.hasDotSegments(value)) {
            return null;
        }
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        if (value.isEmpty()) {
            return null;
        }
        for (String segment : value.split("/", -1)) {
            if (segment.isEmpty()) {
                return null;
            }
        }
        return value;
    }

    /** 用工作区已存的主根换算相对路径形态；工作区不存在 ⇒ null。 */
    public String declarationKeyForRelative(String workspaceId, String relativePath) {
        UUID id = parseWorkspaceId(workspaceId);
        if (id == null) {
            return null;
        }
        return workspaces.findById(id)
                .map(workspace -> declarationKeyFromRelative(id.toString(), workspace.getHostPath(),
                        relativePath))
                .orElse(null);
    }

    /** 用工作区已存的主根换算；主根之外（含二级根）返回 null。 */
    public String declarationKeyFor(String workspaceId, String candidatePath) {
        UUID id = parseWorkspaceId(workspaceId);
        if (id == null) {
            return null;
        }
        Optional<Workspace> workspace = workspaces.findById(id);
        return workspace.map(value -> declarationKey(id.toString(), value.getHostPath(), candidatePath))
                .orElse(null);
    }

    /** 生产侧作用域解析器：只有工作区级可解析，实例级今天缺锚点 ⇒ null。 */
    public ResourceIdentity.RootScope scopeFor(String rootScopeId) {
        UUID id = parseWorkspaceId(rootScopeId);
        if (id == null) {
            return null;
        }
        return workspaces.findById(id)
                .map(workspace -> new ResourceIdentity.RootScope(
                        ResourceIdentity.ScopeKind.WORKSPACE, workspace.getHostPath()))
                .orElse(null);
    }

    /** 只接受 UUID 形态的命名空间 id；其它一律 null（fail-closed）。 */
    public UUID parseWorkspaceId(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException notAUuid) {
            return null;
        }
    }
}
