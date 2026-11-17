import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    DENIED_PERMISSION_ATOMS,
    isDeniedPreviewMode,
    mockPermissionProjection,
    PREVIEW_PERMISSION_ATOMS,
    PREVIEW_WORKSPACE_ATOMS,
} from "../mock/data/previewPermissions";

/**
 * task-249：preview 权限投影夹具（`/me/permissions`）的**名字与切换**守卫。
 *
 * <p>为什么值得单测：权限投影是"页面能不能用"的总闸，错一个原子名会让预览里整页变 403 或整页变
 * 可写，而 preview 车道**没有 e2e/组件测试覆盖**。这里钉三件事：①原子名照 CP 真实目录（尤其
 * `credential_manage` 不许写错大小写/别造名字）；②受限模式**只**扣一个原子、其余照给（否则
 * "403 形态"会变成"整个账号没权限"的假形态）；③`?denied=1` 的判定规则（`Referer` 解析）。</p>
 */
describe("preview 权限投影（task-249）", () => {
    it("默认投影含 credential_manage（与 ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE 逐字相同）", () => {
        const atoms = PREVIEW_PERMISSION_ATOMS.map((atom) => atom.actionClass);
        expect(atoms).toContain("credential_manage");
        // 该页 403 文案点名的是同一个串（`CredentialAdminService` 的守卫原文）。
        expect(atoms).not.toContain("credential_manage@credential:*");
    });

    it("原子清单无重复（重复项在 CP 侧是两条授权，夹具里就是把自己骗了）", () => {
        const atoms = PREVIEW_PERMISSION_ATOMS.map((atom) => atom.actionClass);
        expect(new Set(atoms).size).toBe(atoms.length);
        for (const atom of PREVIEW_PERMISSION_ATOMS) expect(atom.resource).toBe("*");
    });

    it("授权模式：原样给齐全集，capabilities 由调用方透传", () => {
        const body = mockPermissionProjection({ capabilities: ["isInstanceAdmin"], denied: false });
        expect(body.instanceCapabilities).toEqual(["isInstanceAdmin"]);
        expect(body.instancePermissions).toHaveLength(PREVIEW_PERMISSION_ATOMS.length);
        expect(body.instancePermissions.map((atom) => atom.actionClass)).toContain(
            "credential_manage",
        );
    });

    it("受限模式：只扣 credential_manage，其余原子照给（保留真实 403 形态，不变成空权限账号）", () => {
        const body = mockPermissionProjection({ capabilities: ["isInstanceAdmin"], denied: true });
        const atoms = body.instancePermissions.map((atom) => atom.actionClass);
        expect(atoms).not.toContain("credential_manage");
        for (const denied of DENIED_PERMISSION_ATOMS) expect(atoms).not.toContain(denied);
        const expected = PREVIEW_PERMISSION_ATOMS.length - DENIED_PERMISSION_ATOMS.length;
        expect(body.instancePermissions).toHaveLength(expected);
        // 例如 MANAGE_SKILL_LIBRARY 这类别的页要用到的原子必须还在。
        expect(atoms).toContain("MANAGE_SKILL_LIBRARY");
    });

    it("?denied=1 判定：从 Referer 的页面 URL 读，支持 1/true，其余一律授权模式", () => {
        expect(
            isDeniedPreviewMode("http://127.0.0.1:5199/resources/credentials?layer=USER&denied=1"),
        ).toBe(true);
        expect(isDeniedPreviewMode("http://127.0.0.1:5199/resources/credentials?denied=true")).toBe(
            true,
        );
        expect(isDeniedPreviewMode("http://127.0.0.1:5199/resources/credentials?denied=0")).toBe(
            false,
        );
        expect(isDeniedPreviewMode("http://127.0.0.1:5199/resources/credentials?layer=USER")).toBe(
            false,
        );
        expect(isDeniedPreviewMode(undefined)).toBe(false);
        expect(isDeniedPreviewMode("")).toBe(false);
        expect(isDeniedPreviewMode("not-a-url")).toBe(false);
    });
});

/**
 * task-70：**「原子名必须在 CP 真实目录里」的机器判据**（本卡核心）。
 *
 * <p><b>为什么需要</b>：上面那个 describe 钉的是「无重复 / resource 是 `*` / 受限模式只扣一条」，
 * 全是**形状**断言 —— 一个编造的名字照样能通过。事实是：本文件此前躺着 `MANAGE_INSTANCE_CONFIG` 与
 * `VIEW_INSTANCE_AUDIT`，`grep packages/control-plane/**` **0 hits**，而注释写着「不许编造」。
 * 注释是自律、不是判据；同族 `D-1760`（观测采了没判定）说的就是这种「绿了但没人判」。</p>
 *
 * <p><b>实现方式（(a) 直接读 CP 源码做字符串/集合包含检查）</b>：不维护一份手写白名单 ——
 * 白名单本身就是第二个可以编造的东西。这里直读
 * `packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/policy/ToolFaceRegistry.java`：</p>
 *
 * <ul>
 *   <li>先抽 `public static final String ACTION_X = "VALUE";` 的**声明表**（`:20-146` 一段）；</li>
 *   <li>再抽 `builtinActionClasses()` 的**词汇表**（`:260-308`） —— 那是
 *       `GrantIntersectionEvaluator` 校验 grant 用的集合，`MemoryWriteAtomTest` 断言
 *       `PermissionAtomCatalog.actionAtoms() == builtinActionClasses()`。**只在声明表里、
 *       不在词汇表里**的常量在 CP 侧不会被任何授权评估接受（`ToolFaceRegistry.java:266-267`
 *       「a constant without this line is invisible」）。</li>
 * </ul>
 *
 * <p><b>判据（两个断言，都能红）</b>：①每个 `actionClass` 都出现在**声明值**里；
 * ②每个 `actionClass` 都出现在**词汇表**里。把任意一条改成 `FAKE_ATOM_X`，①与②同时红
 * —— 变异读数见卡面（task-70）。</p>
 *
 * <p><b>为什么读源码文本而不是 import/编译 Java</b>：UI 包的单测不跑 JVM（跑一次编译器要起 mvn），
 * 而这道门要守的是「名字存在」这一**静态事实**，不是「行为正确」。同形先例：
 * `src/stores/__tests__/authInstanceAtomScope.spec.ts:129-147` 读 `WorkspaceAgentsPanel.vue` 与
 * `e2e/mock/helpers/auth.ts` 的源码文本；`src/preview/mock/__tests__/schemaCatalog.spec.ts` 读
 * CP 的 config-schemas。**读源码文本的代价**：CP 改了常量名/词汇表结构，这道门会红 —— 那是**应该**红的
 * （改名确实要同批改夹具），不是误报。</p>
 */
describe("task-70 · 预览原子名必须在 CP 真实目录里（机器判据）", () => {
    /**
     * vitest 的 cwd 是包根 `packages/ui`（`vite.config.ts` 的 `test` 段没有改 root）⇒
     * CP 在自己旁边的兄弟包里。用 `process.cwd()` 而不是 `import.meta.url`：jsdom 环境下
     * `import.meta.url` 不是 `file:` scheme（实测 `TypeError: The URL must be of scheme file`）。
     */
    const CP_POLICY_DIR = resolve(
        process.cwd(),
        "../control-plane/src/main/java/com/cc01cc/p/xihe/cp/policy",
    );
    const TOOL_FACE_REGISTRY = resolve(CP_POLICY_DIR, "ToolFaceRegistry.java");
    const SIGNATURE = "public static Set<String> builtinActionClasses()";

    /**
     * 读不到 CP 源码时**抛明确的话**，而不是让断言在 collect 期以 `expect(undefined)` 的形状糊掉：
     * 只有 `ui` 单体检出（没有兄弟 `control-plane/`）时，这道门无法判定 —— 那必须是一条
     * 「门在这里断了」的红，不是静默跳过（跳过就等于没有门）。
     */
    if (!existsSync(TOOL_FACE_REGISTRY)) {
        throw new Error(
            `task-70 判据需要 CP 源码：${TOOL_FACE_REGISTRY} 不存在。` +
                "本包单测假定 UI 与 control-plane 在同一检出（同 `packages/`）；" +
                "只用 ui 单体检出时这道门无法判定，请按仓库拓扑跑（不要改成 skip）。",
        );
    }

    const CP_SOURCE = readFileSync(TOOL_FACE_REGISTRY, "utf8");
    /** `public static final String ACTION_X = "VALUE";` ⇒ `VALUE`（只认这一种声明形态）。 */
    const DECLARED = new Set(
        [...CP_SOURCE.matchAll(/public static final String [A-Z0-9_]+ = "([^"]+)";/g)].map(
            (m) => m[1],
        ),
    );

    /**
     * `builtinActionClasses()` 的**方法体**（从签名后第一个 `{` 到匹配的收尾 `}`）。抽方法体而不是全文：
     * 同名常量在别的 set 里出现（`READ_TOOLS`/`WRITE_TOOLS` 是**工具名**不是动作原子，
     * `faces` map 里也有字面量）会把「在词汇表里」变成一句空话。
     */
    const START = CP_SOURCE.indexOf(SIGNATURE);
    const BUILTIN_BODY = (() => {
        if (START <= 0) return "";
        const open = CP_SOURCE.indexOf("{", START);
        // 方法体里没有嵌套花括号（只有 Set.of(...) 与行注释）⇒ 第一个右花括号就是方法收尾。
        const close = CP_SOURCE.indexOf("}", open);
        // 去行注释：正文注释里也会写原子名，留着会让「在词汇表里」变成一句空话（判据必须只认代码）。
        return CP_SOURCE.slice(open, close).replaceAll(/\/\/.*$/gm, "");
    })();
    /** 词汇表里的**值**：`builtinActionClasses()` 引用的是常量名，逐个映射回声明值。 */
    const VOCABULARY = new Set(
        [...BUILTIN_BODY.matchAll(/ACTION_[A-Z0-9_]+/g)]
            .map((m) => m[0])
            // 常量名 ⇒ 声明值。用 ACTION_ 前缀重构声明行，找不到就是 CP 内部不一致（应当红）。
            .map((constant) => {
                const declared = CP_SOURCE.match(
                    new RegExp(`public static final String ${constant} = "([^"]+)";`),
                );
                return declared?.[1];
            })
            .filter((value): value is string => typeof value === "string"),
    );

    const names = PREVIEW_PERMISSION_ATOMS.map((atom) => atom.actionClass);
    const workspaceNames = PREVIEW_WORKSPACE_ATOMS.map((atom) => atom.actionClass);

    it("判据前提：CP 的 builtinActionClasses() 方法体读到了（否则下面两条是全绿的空门）", () => {
        // ≠ 造绿：方法体空着时「每条都在词汇表里」会是**空集上的全称断言**，恒真。
        expect(
            START,
            "CP 的 builtinActionClasses() 方法签名不在了（改名要同批改这道门）",
        ).toBeGreaterThan(0);
        expect(VOCABULARY.size).toBeGreaterThan(20);
    });

    it("每条实例档原子都在 ToolFaceRegistry 的常量声明里（编造名在这里红）", () => {
        for (const name of names) expect(DECLARED, `${name} 在 CP 里没有声明`).toContain(name);
        // 反例钉子：这两个名字 CP 全仓 0 hits，是**编出来的**（task-70 删掉它们的原因见夹具注释）。
        // 把它们写在这里，是为了让「以后有人以为是漏配、又想加回来」时先读到这条红。
        expect(DECLARED).not.toContain("MANAGE_INSTANCE_CONFIG");
        expect(DECLARED).not.toContain("VIEW_INSTANCE_AUDIT");
    });

    it("每条实例档原子都在 builtinActionClasses() 词汇表里（授权评估真的会认它）", () => {
        for (const name of names)
            expect(VOCABULARY, `${name} 不在 builtinActionClasses() 词汇表里`).toContain(name);
    });

    it("工作区档原子同样在 CP 真实目录里（两份清单同一把尺，不因是 workspace 档就豁免）", () => {
        for (const name of workspaceNames) {
            expect(DECLARED, `${name} 在 CP 里没有声明`).toContain(name);
            expect(VOCABULARY, `${name} 不在 builtinActionClasses() 词汇表里`).toContain(name);
        }
    });
});
