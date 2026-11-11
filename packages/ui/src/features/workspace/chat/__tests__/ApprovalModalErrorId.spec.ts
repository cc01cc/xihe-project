import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";

/**
 * task-111：`ApprovalModal.vue` 的 `approval-error` 锚点唯一性**判据**（不测业务）。
 *
 * ## 为什么这条断言长这样
 * 三个 error 展示点（`:750/751`、`:926`、`:1090/1091`）落在同一条三元链的三个兄弟分支：
 * `v-if="!saveConfirming && !classifyConfirming"` / `v-else-if="classifyConfirming"` / `v-else`
 * ⇒ 同时最多渲染一个。所以正确的判据是**每态计数 ≤ 1**：
 *  - 写 `= 1` 会假红：`error` 为空时本来就没有节点；
 *  - 写"全局计数 = 1"没有分辨力：互斥与不互斥在该口径下都得 1。
 *
 * ## 本文件为什么先用结构桩而不是真组件
 * 真组件的两条非默认态（`classifyConfirming` / `saveConfirming`）是**内部 ref**，
 * 只能靠交互驱动（点分类入口 / 点保存），需要完整 `ApprovalRequest` 夹具与全量 i18n 文案；
 * 而那套夹具住在 `ApprovalModal.spec.ts` 里，**该文件此刻正被 task-105 编辑**。
 * 因此本文件先锁"判据本身有没有分辨力"（正例 + 负例），真组件的三态接线
 * 等 task-105 收口后再由夹具所有者补（见文件末 `TODO(port)`）。
 */

/** 复刻 ApprovalModal 的**互斥**形态：同一条 v-if / v-else-if / v-else 链。 */
const ExclusiveChain = defineComponent({
    props: { error: { type: String, default: null }, mode: { type: String, default: "normal" } },
    setup(props) {
        return () =>
            h("div", [
                props.mode === "normal"
                    ? h("section", [
                          props.error ? h("p", { id: "approval-error" }, props.error) : null,
                      ])
                    : props.mode === "classify"
                      ? h("section", [
                            props.error ? h("p", { id: "approval-error" }, props.error) : null,
                        ])
                      : h("section", [
                            props.error ? h("p", { id: "approval-error" }, props.error) : null,
                        ]),
            ]);
    },
});

/** 负例形态：把 `v-else-if` 改成**并列 `v-if`** —— 三个分支可同时成立。 */
const ParallelBranches = defineComponent({
    props: { error: { type: String, default: null } },
    setup(props) {
        const flags = ref({ a: true, b: true, c: true });
        return () =>
            h("div", [
                flags.value.a
                    ? h("section", [
                          props.error ? h("p", { id: "approval-error" }, props.error) : null,
                      ])
                    : null,
                flags.value.b
                    ? h("section", [
                          props.error ? h("p", { id: "approval-error" }, props.error) : null,
                      ])
                    : null,
                flags.value.c
                    ? h("section", [
                          props.error ? h("p", { id: "approval-error" }, props.error) : null,
                      ])
                    : null,
            ]);
    },
});

const countAnchors = (wrapper: ReturnType<typeof mount>) => ({
    testid: wrapper.findAll('[data-testid="approval-error"]').length,
    id: wrapper.findAll('[id="approval-error"]').length,
});

describe("approval-error 锚点唯一性判据", () => {
    it("正例：互斥链在每个模式下最多一个锚点（error 为空时为 0）", () => {
        for (const mode of ["normal", "classify", "save"]) {
            const withError = mount(ExclusiveChain, { props: { mode, error: "boom" } });
            const hits = countAnchors(withError);
            expect(hits.id, `mode=${mode} 有 error 时`).toBeLessThanOrEqual(1);
            withError.unmount();

            const withoutError = mount(ExclusiveChain, { props: { mode, error: null } });
            expect(countAnchors(withoutError).id, `mode=${mode} 无 error 时`).toBe(0);
            withoutError.unmount();
        }
    });

    it("负例：并列 v-if（不互斥）时计数 = 3 ⇒ 证明该判据有分辨力", () => {
        const wrapper = mount(ParallelBranches, { props: { error: "boom" } });
        // 若这里也是 1，说明断言测不出"互斥被破坏"——那这条判据就是假门。
        expect(countAnchors(wrapper).id).toBe(3);
        wrapper.unmount();
    });
});

/**
 * TODO(port)：task-105 收口后，把正例换成真组件三态（用 `ApprovalModal.spec.ts` 的
 * `mountModal(props)` 与 `baseApproval` 夹具 + 交互驱动）：
 *   ① 默认态 + `error="boom"` ⇒ `[data-testid="approval-error"]` ≤ 1
 *   ② 点分类入口进 `classifyConfirming` ⇒ 同上 ≤ 1
 *   ③ 点保存进 `saveConfirming` ⇒ 同上 ≤ 1
 * 三个 `id` 计数同样 ≤ 1。做这一步时**必须**在 `ApprovalModal.spec.ts` 之外新建文件，
 * 且先确认 ui-2 的 task-105 已 complete（否则互相覆盖）。
 */
