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
