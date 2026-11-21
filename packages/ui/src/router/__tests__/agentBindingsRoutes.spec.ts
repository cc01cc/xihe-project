import { describe, expect, it } from "vitest";

import { settingsLayerForPath } from "../../lib/settingsIa";
import router from "../index";

/**
 * task-153（Lead 2026-11-21 04:02 裁定 C1=B + 04:08 H7 ②）：主体绑定**整页**的路由判据。
 *
 * <p>为什么单独开一个 spec 文件钉这一条：`meta.settingsLayer` 漏写时页面**不会白屏**，
 * 而是被 `lib/settingsIa.ts:142 settingsLayerForPath` 兜底成 "instance" —— 恰好也是对的，
 * 于是这个漏写能一路活到下次有人改兜底逻辑。task-160 的「/settings/workspace-default/rag
 * 顶着『用户配置』」就是这么来的。所以这里不信兜底，直接断言 meta 字面值。</p>
 *
 * <p>另钉两件：页面确实挂在 `/settings` 壳之下（不是 404 兜底），以及面包屑第二段的
 * 同层向上链接 `/settings/instance/agent-principals` 真能解析到权威列表页。</p>
 *
 * <p><b>层身份两条独立断言</b>（Lead 2026-11-21 10:52 裁定）：路径自身的 `instance/` 前缀
 * 推导出的层，与 `meta.settingsLayer` 各测一条。只钉 meta 的话，将来有人把 path 改回无前缀
 * 而 meta 留着，测试照样绿 —— 那就退回到「靠 meta 单点判据」的旧形状了。</p>
 */

const BINDINGS_PATH = "/settings/instance/agent-principals/:id/bindings";
const BINDINGS_NAME = "settings-agent-principal-bindings";

function record() {
    const found = router.getRoutes().find((route) => route.path === BINDINGS_PATH);
    expect(found, "缺少路由记录：" + BINDINGS_PATH).toBeTruthy();
    return found!;
}

describe("主体绑定整页路由（task-153）", () => {
    it("已注册：name / 懒加载组件 / props:true", () => {
        const route = record();
        expect(route.name).toBe(BINDINGS_NAME);
        expect(typeof route.components?.default).toBe("function");
        expect(route.props.default).toBe(true);
    });

    it("路径推导层 = instance（不依赖 meta，单看 path 也要对）", () => {
        expect(settingsLayerForPath(BINDINGS_PATH.replace(":id", "p-1"))).toBe("instance");
        expect(settingsLayerForPath(record().path.replace(":id", "p-1"))).toBe("instance");
    });

    it("meta.settingsLayer 显式是 instance（冗余护栏，与路径推导分开断言）", () => {
        expect(record().meta.settingsLayer).toBe("instance");
    });

    it("深链可解析：命中真实路由而不是设置区 404 兜底", () => {
        const resolved = router.resolve("/settings/instance/agent-principals/p-1/bindings");
        expect(resolved.name).toBe(BINDINGS_NAME);
        expect(resolved.params.id).toBe("p-1");
        expect(resolved.name).not.toBe("settings-not-found");
        expect(resolved.matched.length).toBeGreaterThan(1);
        // 挂在 /settings 壳下（父级链里有设置布局那一条）。
        expect(resolved.matched[0]?.path).toBe("/settings");
    });

    it("面包屑第二段的目标 /settings/instance/agent-principals 真实存在", () => {
        const resolved = router.resolve("/settings/instance/agent-principals");
        expect(resolved.name).toBe("settings-instance-agent-principals");
        expect(resolved.name).not.toBe("settings-not-found");
    });
});
