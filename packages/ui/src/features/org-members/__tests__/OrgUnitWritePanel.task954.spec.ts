import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../../i18n";
import { setOnlySelectValue } from "../../../test-utils/select";
import OrgUnitWritePanel from "../components/OrgUnitWritePanel.vue";

/**
 * task-954：组织单元弹窗族的语义正确性（R20/R22/R23/R28）。
 *
 * <p>本 spec 刻意不测视觉形态（组织页将由 task-934 的树内就地编辑重做），只钉四件
 * 用户可观察的事实：新建时父单元可见、未选中不发必然 403 的请求、加成员可搜可多选、
 * 文案承诺的「需要你确认」真的先发生再写入。</p>
 */

const UNIT = { id: "u-root", name: "研发部", parentId: null, depth: 0, hasChildren: false };

interface Call {
    method: string;
    path: string;
    body: string;
}

let calls: Call[] = [];

type Handler = (url: URL, method: string) => { status: number; body?: unknown };

function mockApi(handler: Handler): void {
    calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const raw = typeof input === "string" ? input : input.url;
        const url = new URL(raw, "http://localhost");
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({
            method,
            path: url.pathname + url.search,
            body: typeof init?.body === "string" ? init.body : "",
        });
        const reply = handler(url, method);
        const payload = reply.body === undefined ? null : JSON.stringify(reply.body);
        return Promise.resolve(
            new Response(payload, {
                status: reply.status,
                headers: reply.body === undefined ? {} : { "content-type": "application/json" },
            }),
        );
    });
}

function writeCalls(): Call[] {
    return calls.filter((call) => call.method !== "GET");
}

function candidateCalls(): Call[] {
    return calls.filter((call) =>
        call.path.startsWith("/api/v1/org-units/u-root/member-candidates"),
    );
}

async function mountPanel(unit: typeof UNIT | null) {
    const wrapper = mount(OrgUnitWritePanel, {
        props: { unit },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
    await flushPromises();
    return wrapper;
}

function dialog(testid: string): HTMLElement | null {
    return document.body.querySelector(`[data-testid="${testid}"]`);
}

async function clickCheckbox(memberId: string): Promise<void> {
    const label = dialog(`org-write-subject-${memberId}`) as HTMLElement;
    const checkbox = label.querySelector("input") as HTMLInputElement;
    // 直接写 checked 再派发 change：`input.click()` 在 label 内会被 jsdom 的标签激活再点一次，
    // 表现为「勾上又被取消」的假红。
    if (!checkbox.checked) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await flushPromises();
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
});

describe("task-954 R20/R22：新建子单元的父单元与禁用门", () => {
    it("未选中单元 ⇒ 「新建子单元」禁用、tooltip 说明原因、点击不发请求", async () => {
        mockApi(() => ({ status: 200, body: { nodes: [] } }));
        const wrapper = await mountPanel(null);

        const button = wrapper.get('[data-testid="org-write-new-unit"]');
        expect(button.element.hasAttribute("disabled")).toBe(true);
        const wrap = button.element.closest("span");
        expect(wrap?.getAttribute("title")).toBe("先在左栏选择一个组织单元。");

        (button.element as HTMLButtonElement).click();
        await flushPromises();
        expect(calls.length, "禁用态仍然发了请求").toBe(0);
        expect(dialog("org-write-dialog") ?? null).toBeNull();
        wrapper.unmount();
    });

    it("选中单元 ⇒ 新建表单只读显示父单元名称（R20）", async () => {
        mockApi(() => ({ status: 200, body: { nodes: [] } }));
        const wrapper = await mountPanel(UNIT);

        await wrapper.get('[data-testid="org-write-new-unit"]').trigger("click");
        await vi.waitFor(() => expect(dialog("org-write-dialog")).toBeTruthy());

        expect(dialog("org-write-create-parent-name")?.textContent?.trim()).toBe("研发部");
        wrapper.unmount();
    });

    it("程序化打开 create 且无选中 ⇒ 父单元显示「顶层」，提交按钮禁用（R20+R22）", async () => {
        mockApi(() => ({ status: 200, body: { nodes: [] } }));
        const wrapper = await mountPanel(null);

        await (wrapper.vm as { open: (mode: string) => Promise<void> }).open("create");
        await vi.waitFor(() => expect(dialog("org-write-dialog")).toBeTruthy());

        expect(dialog("org-write-create-parent-name")?.textContent?.trim()).toBe(
            "（顶层单元，没有父单元）",
        );
        const submit = dialog("org-write-submit") as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        wrapper.unmount();
    });
});

describe("task-954 R28/R23：加成员先确认、可多选", () => {
    it("人工多选：首击只落确认态（零写请求），确认后 N 条 PUT（R23+R28）", async () => {
        mockApi((url) => {
            if (url.pathname.endsWith("/member-candidates")) {
                return {
                    status: 200,
                    body: {
                        candidates: [
                            { memberKind: "human", memberId: "m-1", displayName: "alice" },
                            { memberKind: "human", memberId: "m-2", displayName: "bob" },
                        ],
                    },
                };
            }
            if (url.pathname.includes("/members/")) {
                return {
                    status: 200,
                    body: {
                        memberId: url.pathname.split("/").at(-1),
                        fromOrgUnitId: null,
                        toOrgUnitId: "u-root",
                        affectedWorkspaceIds: [],
                        auditEvent: "org.unit.member.placed",
                    },
                };
            }
            return { status: 200, body: {} };
        });
        const wrapper = await mountPanel(UNIT);
        await wrapper.get('[data-testid="org-write-add-member"]').trigger("click");
        await vi.waitFor(() => expect(dialog("org-write-subject-m-1")).toBeTruthy());

        // task-985：请求必须打到 candidate 端点，且不再调全集目录面。
        expect(candidateCalls().length, "加成员候选必须走 /member-candidates").toBe(1);
        expect(dialog("org-write-subject-m-1")).toBeTruthy();
        expect(
            calls.filter((call) => call.path.startsWith("/api/v1/users")),
            "不得再取全量用户目录后本地过滤",
        ).toEqual([]);

        await clickCheckbox("m-1");
        await clickCheckbox("m-2");
        await flushPromises();
        expect(writeCalls().length, "勾选本身不应发写请求").toBe(0);
        expect(writeCalls().filter((call) => call.path.includes("/members/"))).toEqual([]);

        (dialog("org-write-submit") as HTMLButtonElement).click();
        await vi.waitFor(() => expect(dialog("org-write-add-confirm-panel")).toBeTruthy());
        expect(writeCalls().length, "首击提交就写入了 —— R28 文案与行为不一致").toBe(0);
        expect(dialog("org-write-add-confirm-panel")?.textContent).toContain("需要你确认");
        expect(dialog("org-write-add-confirm-m-1")).toBeTruthy();
        expect(dialog("org-write-add-confirm-m-2")).toBeTruthy();

        (dialog("org-write-add-confirm") as HTMLButtonElement).click();
        await vi.waitFor(() => {
            const puts = writeCalls().filter(
                (call) => call.method === "PUT" && call.path.includes("/members/"),
            );
            expect(puts.length).toBe(2);
        });
        const puts = writeCalls().filter((call) => call.method === "PUT");
        expect(puts.map((call) => call.path)).toEqual([
            "/api/v1/org-units/u-root/members/m-1?memberKind=human",
            "/api/v1/org-units/u-root/members/m-2?memberKind=human",
        ]);
        wrapper.unmount();
    });

    it("智能体模式：搜索框可用、按名称过滤、跨搜索保留多选并提交 N 条 agent_principal", async () => {
        mockApi((url, method) => {
            if (url.pathname.endsWith("/member-candidates")) {
                const needle = (url.searchParams.get("q") ?? "").toLowerCase();
                const all = [
                    { memberKind: "agent_principal", memberId: "p-1", displayName: "codebot" },
                    { memberKind: "agent_principal", memberId: "p-2", displayName: "writer" },
                ];
                return {
                    status: 200,
                    body: {
                        // 服务端按 display-name 过滤；mock 只复现「q 只缩不放」的契约。
                        candidates: needle
                            ? all.filter((row) => row.displayName.toLowerCase().includes(needle))
                            : all,
                    },
                };
            }
            if (method === "PUT" && url.pathname.includes("/members/")) {
                return {
                    status: 200,
                    body: {
                        memberId: url.pathname.split("/").at(-1),
                        fromOrgUnitId: null,
                        toOrgUnitId: "u-root",
                        affectedWorkspaceIds: [],
                        auditEvent: "org.unit.member.placed",
                    },
                };
            }
            return { status: 200, body: { items: [] } };
        });
        const wrapper = await mountPanel(UNIT);
        await wrapper.get('[data-testid="org-write-add-member"]').trigger("click");
        await vi.waitFor(() => expect(dialog("org-write-search")).toBeTruthy());

        await setOnlySelectValue(wrapper, "agent_principal");
        await vi.waitFor(() => expect(dialog("org-write-subject-p-1")).toBeTruthy());

        // task-985：智能体模式同样走 candidate 端点，不再调 /agent-principals 全集。
        expect(
            calls.filter((call) => call.path.startsWith("/api/v1/agent-principals")),
            "不得再取全量 agent principal 后本地过滤",
        ).toEqual([]);
        expect(candidateCalls().at(-1)?.path).toContain("memberKind=agent_principal");

        const search = dialog("org-write-search") as HTMLInputElement;
        expect(search.hasAttribute("disabled"), "智能体模式搜索框被禁用").toBe(false);

        search.value = "code";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        // v-model on the shadcn Input goes through a watcher (pre-flush); let it land before Enter.
        await flushPromises();
        search.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        await vi.waitFor(() => {
            expect(dialog("org-write-subject-p-1")).toBeTruthy();
            expect(dialog("org-write-subject-p-2")).toBeNull();
        });
        await clickCheckbox("p-1");

        search.value = "";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        await flushPromises();
        search.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        await vi.waitFor(() => expect(dialog("org-write-subject-p-2")).toBeTruthy());
        await clickCheckbox("p-2");
        await flushPromises();

        (dialog("org-write-submit") as HTMLButtonElement).click();
        await vi.waitFor(() => expect(dialog("org-write-add-confirm-panel")).toBeTruthy());
        expect(dialog("org-write-add-confirm-p-1")).toBeTruthy();
        expect(dialog("org-write-add-confirm-p-2")).toBeTruthy();
        expect(writeCalls().length).toBe(0);

        (dialog("org-write-add-confirm") as HTMLButtonElement).click();
        await vi.waitFor(() => {
            const puts = writeCalls().filter(
                (call) => call.method === "PUT" && call.path.includes("/members/"),
            );
            expect(puts.length).toBe(2);
        });
        const puts = writeCalls().filter((call) => call.method === "PUT");
        expect(puts.map((call) => call.path)).toEqual([
            "/api/v1/org-units/u-root/members/p-1?memberKind=agent_principal",
            "/api/v1/org-units/u-root/members/p-2?memberKind=agent_principal",
        ]);
        wrapper.unmount();
    });
});
