package com.cc01cc.p.xihe.cp.policy;

import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-533：声明键生产者（路径 → {@code fs:<workspaceId>/<rel>}）。
 *
 * <p>最后一条用例是判据 ② 的单元级落点：授予行里的声明键保持<b>未归一</b>原始形态（大写 SRC），
 * 请求侧用生产者<b>真实产出</b>的键，两者串不同但 phys 相同 ⇒ 求交必须成立。若把求交退化成串比较，
 * 这条当场变红。</p>
 */
class FsResourceKeysTest {

    @Test
    void pathUnderRootBecomesDeclarationKey() {
        assertEquals("fs:ws-1/src/app.ts",
                FsResourceKeys.declarationKey("ws-1", "H:/ws", "H:\\ws\\src\\app.ts"));
    }

    @Test
    void rootItselfIsTheBareKey() {
        assertEquals("fs:ws-1", FsResourceKeys.declarationKey("ws-1", "H:/ws/", "h:/WS"));
    }

    @Test
    void outsideRootOrDotSegmentsOrNonPathAreRefused() {
        assertNull(FsResourceKeys.declarationKey("ws-1", "H:/ws", "H:/other/x"), "根外不得生成键");
        assertNull(FsResourceKeys.declarationKey("ws-1", "H:/ws", "H:/ws/../etc"), "点段 fail-closed");
        assertNull(FsResourceKeys.declarationKey("ws-1", "H:/ws", "credential:abc"), "非路径不得生成键");
        assertNull(FsResourceKeys.declarationKey("", "H:/ws", "H:/ws/a"), "空命名空间不得生成键");
        assertNull(FsResourceKeys.declarationKey(null, "H:/ws", "H:/ws/a"));
    }

    /** {@code H:/wsx} 不是 {@code H:/ws} 之内 —— 前缀兄弟必须靠段边界判，不能 startsWith。 */
    @Test
    void prefixSiblingIsNotWithin() {
        assertNull(FsResourceKeys.declarationKey("ws-1", "H:/ws", "H:/wsx/a"));
    }

    @Test
    void workspaceIdMustBeAUuid() {
        FsResourceKeys keys = new FsResourceKeys(null, null);
        assertNull(keys.parseWorkspaceId("ws-1"), "非 UUID 命名空间 fail-closed");
        assertNull(keys.parseWorkspaceId(" "));
        assertNotNull(keys.parseWorkspaceId("3f2a1b4c-0000-4000-8000-000000000001"));
    }

    /**
     * 判据 ② 单元级：授予行声明键保持未归一（{@code /SRC}），请求侧由生产者产出（{@code /src}），
     * 串不同、phys 相同 ⇒ 求交成立；同时断言「串比较会判不同」以防假绿。
     */
    @Test
    void unnormalizedGrantKeyStillIntersectsThroughPhysicalKey() {
        String workspaceId = "3f2a1b4c-0000-4000-8000-000000000001";
        String root = "H:/ws";
        String grantResource = "fs:" + workspaceId + "/SRC";
        String requestResource = FsResourceKeys.declarationKey(workspaceId, root, "H:\\WS\\src\\App.ts");
        assertNotNull(requestResource);

        Map<String, ResourceIdentity.RootScope> scopes = Map.of(workspaceId,
                new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.WORKSPACE, root));
        Boolean matched = ResourceIdentity.matchesDeclaration(grantResource, requestResource, scopes::get);
        assertEquals(Boolean.TRUE, matched, "phys 相等即必须相交");

        // 防假绿：两条串确实不同，且串比较会判不同 —— 相交只可能来自 phys。
        assertFalse(grantResource.equalsIgnoreCase(requestResource) && grantResource.equals(requestResource));
        assertTrue(grantResource.endsWith("/SRC"), "授予行保持未归一形态");
        assertTrue(requestResource.endsWith("/src/app.ts"), "生产者输出已词法归一");
    }
}
