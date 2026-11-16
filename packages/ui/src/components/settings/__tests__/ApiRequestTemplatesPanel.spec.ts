/**
 * 本文件测的组件是 **`../ContextTemplatesPanel.vue`**（不是同名的 ApiRequestTemplatesPanel.vue ——
 * 那个文件不存在）。命名漂移是历史遗留：域键叫 `api-request-templates`，组件后来改名为
 * ContextTemplatesPanel。**改该组件的人请 grep 组件名而不是文件名**，否则会误判「没有单测」。
 * （runtime-1 在 task-409 复核时照出；重命名文件会动 import 路径，另批再做。）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import Panel from "../ContextTemplatesPanel.vue";
import { listApiInputTypes } from "../../../services/providerConnectionService";
import { readTemplateConfig, validateTemplate } from "../../../services/apiRequestTemplates";
import { jsonDocText, jsonEditorView, setJsonDoc } from "./jsonEditorAsserts";
import type * as apiRequestTemplatesModule from "../../../services/apiRequestTemplates";

vi.mock("../../../services/providerConnectionService", () => ({
    listApiInputTypes: vi.fn<typeof listApiInputTypes>(),
}));
vi.mock("../../../services/apiRequestTemplates", async (importOriginal) => ({
    ...(await importOriginal<typeof apiRequestTemplatesModule>()),
    readTemplateConfig: vi.fn<typeof readTemplateConfig>(),
    validateTemplate: vi.fn<typeof validateTemplate>(),
}));
vi.mock("vue-sonner", () => ({
    toast: {
        info: vi.fn<(message: string) => void>(),
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const builtin = {
    id: "builtin",
    version: 1,
    name: "Builtin",
    apiTypeId: "openai-chat-completions",
    apiTypeVersion: 1,
    bodySource: '{"model":"${xh.model}","messages":[{"role":"user","content":"${xh.user_input}"}]}',
    status: "published",
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listApiInputTypes).mockResolvedValue({
        types: [{ apiTypeId: builtin.apiTypeId, version: 1, operation: "chat" }],
    } as Awaited<ReturnType<typeof listApiInputTypes>>);
    vi.mocked(readTemplateConfig).mockResolvedValue({ templates: JSON.stringify([builtin]) });
    vi.mocked(validateTemplate).mockResolvedValue({ valid: true, diagnostics: [] });
});

describe("API request template lifecycle", () => {
    it("clears the previous scope selection and ignores its late publication", async () => {
        let finish!: (value: { valid: boolean; diagnostics: [] }) => void;
        vi.mocked(validateTemplate).mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "user",
            },
        });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-publish"]').trigger("click");
        // task-253：层是唯一的重置轴（workspaceId prop 已随工作区层一起移除）。
        await wrapper.setProps({ layer: "instance", entries: {} });
        expect(wrapper.find('[data-testid="api-request-body-source"]').exists()).toBe(false);
        finish({ valid: true, diagnostics: [] });
        await flushPromises();
        expect(wrapper.emitted("save")).toBeUndefined();
        wrapper.unmount();
    });

    /**
     * task-426（task-397 真栈审计发现，ui-review E 内容与真实性）：左列按 `latest`（每 id 取
     * **max version**）渲染，详情初始却取 `templates[0]`（**原始数组顺序**）⇒ 存储里旧版本排在
     * 前面时首屏「列表 v2 / 详情 v1」。真栈复现恒定 5 次采样（证据
     * `internal/A03-xihe/evidence/2026-11-14-instance-flow-audit/template-race-samples.json`）。
     * 判据：初始选中必须与列表第一行**同源**，而不是「数组里第一个」。
     */
    it("初始详情版本与列表第一行同源（旧版本排在数组前面也不选它）", async () => {
        const v2 = { ...builtin, version: 2 };
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin, v2]) },
                saving: false,
                layer: "instance",
            },
        });
        await flushPromises();

        const firstRow = wrapper.findAll("nav button")[0];
        expect(firstRow.text()).toContain("v2");
        const revisionTrigger = wrapper.get('[aria-label="settings.apiRequest.revisions"]');
        expect(revisionTrigger.text()).toContain("v2");

        wrapper.unmount();
    });

    it("does not emit a publication after its scope instance unmounts", async () => {
        let finish!: (value: { valid: boolean; diagnostics: [] }) => void;
        vi.mocked(validateTemplate).mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "user",
            },
        });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-publish"]').trigger("click");
        wrapper.unmount();
        finish({ valid: true, diagnostics: [] });
        await flushPromises();
        expect(wrapper.emitted("save")).toBeUndefined();
    });

    it("keeps the selection when only entries refresh for the same layer", async () => {
        // task-253：重置判据只剩「层变了」——同层 entries 回填不得把编辑区清掉。
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "user",
            },
        });
        await flushPromises();
        expect(wrapper.find('[data-testid="api-request-body-source"]').exists()).toBe(true);
        await wrapper.setProps({ entries: {} });
        expect(wrapper.find('[data-testid="api-request-body-source"]').exists()).toBe(true);
        wrapper.unmount();
    });
    it("preserves invalid raw source as a draft without invoking publication validation", async () => {
        const wrapper = mount(Panel, { props: { entries: {}, saving: false, layer: "user" } });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-new"]').trigger("click");
        const raw = "{ broken ${xh.user_input}";
        setJsonDoc(wrapper, "api-request-body-source", raw);
        await flushPromises();
        await wrapper.get('[data-testid="api-request-save-draft"]').trigger("click");
        expect(validateTemplate).not.toHaveBeenCalled();
        const payload = wrapper.emitted("save")![0]![0] as Record<string, string>;
        expect(JSON.parse(payload.templates!)[0]).toMatchObject({
            status: "draft",
            bodySource: raw,
        });
        wrapper.unmount();
    });

    it("shows validation diagnostics and does not save an invalid publication", async () => {
        vi.mocked(validateTemplate).mockResolvedValue({
            valid: false,
            diagnostics: [{ code: "JSON_INVALID", path: "$", message: "Invalid JSON" }],
        });
        const wrapper = mount(Panel, { props: { entries: {}, saving: false, layer: "user" } });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-new"]').trigger("click");
        await wrapper.get('[data-testid="api-request-publish"]').trigger("click");
        await flushPromises();
        expect(wrapper.emitted("save")).toBeUndefined();
        expect(wrapper.get('[role="alert"]').text()).toContain("JSON_INVALID");
        wrapper.unmount();
    });

    it("appends a new version while preserving the exact published source", async () => {
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "user",
            },
        });
        await flushPromises();
        const edited = builtin.bodySource.replace("user_input", "agent_instructions");
        setJsonDoc(wrapper, "api-request-body-source", edited + " ");
        await flushPromises();
        await wrapper.get('[data-testid="api-request-publish"]').trigger("click");
        await flushPromises();
        const payload = wrapper.emitted("save")![0]![0] as Record<string, string>;
        const records = JSON.parse(payload.templates!);
        expect(records).toHaveLength(2);
        expect(records[0]).toEqual(builtin);
        expect(records[1]).toMatchObject({
            id: builtin.id,
            version: 2,
            bodySource: edited + " ",
            status: "published",
        });
        wrapper.unmount();
    });

    it("does not publish into another selection when validation finishes late", async () => {
        let finish!: (value: { valid: boolean; diagnostics: [] }) => void;
        vi.mocked(validateTemplate).mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const wrapper = mount(Panel, { props: { entries: {}, saving: false, layer: "user" } });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-new"]').trigger("click");
        await wrapper.get('[data-testid="api-request-publish"]').trigger("click");
        await wrapper.get('[data-testid="api-request-new"]').trigger("click");
        finish({ valid: true, diagnostics: [] });
        await flushPromises();
        expect(wrapper.emitted("save")).toBeUndefined();
        wrapper.unmount();
    });

    // 2026-11-04 事故回归：保存草稿必须等真实写结果，失败要显式呈现，不能「像成功」。
    it("awaits the injected submit and only claims success after it resolves", async () => {
        let finish!: () => void;
        const submit = vi.fn<() => Promise<void>>(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "user",
                submit,
            },
        });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-save-draft"]').trigger("click");
        await flushPromises();
        expect(submit).toHaveBeenCalledTimes(1);
        // 未 resolve 之前不得回显「已保存」
        expect(wrapper.text()).not.toContain("common.saved");
        expect(wrapper.find('[data-testid="api-request-saving"]').exists()).toBe(true);
        finish();
        await flushPromises();
        expect(wrapper.find('[data-testid="api-request-saving"]').exists()).toBe(false);
        expect(wrapper.emitted("save")).toBeUndefined();
        wrapper.unmount();
    });

    it("surfaces a failed save instead of reporting success", async () => {
        const submit = vi
            .fn<() => Promise<void>>()
            .mockRejectedValue(new Error("API_REQUEST_TEMPLATE_REVISION_IMMUTABLE"));
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "user",
                submit,
            },
        });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-save-draft"]').trigger("click");
        await flushPromises();
        expect(submit).toHaveBeenCalledTimes(1);
        expect(wrapper.text()).toContain("API_REQUEST_TEMPLATE_REVISION_IMMUTABLE");
        wrapper.unmount();
    });

    // A4（用户要求）：格式化只改排版，不改语义；非法 JSON 就地报错且原文不动。
    it("formats the source with two-space indentation without changing semantics", async () => {
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "user",
            },
        });
        await flushPromises();
        const compact =
            '{"model":"${xh.model}","messages":[{"role":"user","content":"${xh.user_input}"}],"stream":true}';
        setJsonDoc(wrapper, "api-request-body-source", compact);
        await flushPromises();
        await wrapper.get('[data-testid="api-request-body-source-format"]').trigger("click");
        const formatted = jsonDocText(wrapper, "api-request-body-source");
        expect(formatted).toBe(JSON.stringify(JSON.parse(compact), null, 2));
        expect(formatted).toContain('\n  "model"');
        expect(formatted).toContain("${xh.user_input}");
        expect(JSON.parse(formatted)).toEqual(JSON.parse(compact));
        wrapper.unmount();
    });

    it("rejects invalid JSON without rewriting the source", async () => {
        const wrapper = mount(Panel, {
            props: {
                entries: { templates: JSON.stringify([builtin]) },
                saving: false,
                layer: "user",
            },
        });
        await flushPromises();
        const invalid = '{"model": "x",';
        setJsonDoc(wrapper, "api-request-body-source", invalid);
        await flushPromises();
        await wrapper.get('[data-testid="api-request-body-source-format"]').trigger("click");
        expect(jsonDocText(wrapper, "api-request-body-source")).toBe(invalid);
        // task-34：JSON 解析错误现在由 JsonFieldEditor 自己渲染（编辑器内错误行），不再走面板的 role=alert。
        const alert = wrapper.find('[data-testid="api-request-body-source-error"]');
        expect(alert.text().length).toBeGreaterThan(0);
        wrapper.unmount();
    });
});

/**
 * task-409 P2-2（D-949 第21条 A）：空态只有一句话，没有出口 —— 用户看到「还没有模板」
 * 却要去工具栏找「新建」。空态内嵌 CTA，走**同一条 create 路径**，不另写一份创建逻辑。
 * testid 沿用既有 `api-request-*` 前缀（`api-request-type` 被 2 个 real e2e spec 引用，不改名）。
 */
describe("API request template empty state · task-409 P2-2", () => {
    function mountPanel() {
        return mount(Panel, {
            props: { entries: { templates: JSON.stringify([]) }, saving: false, layer: "user" },
        });
    }

    it("空态给出内嵌新建 CTA", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        const empty = wrapper.get('[data-testid="api-request-empty"]');
        expect(empty.find('[data-testid="api-request-empty-create"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("点空态 CTA 走既有 create 路径，进入草稿详情", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-testid="api-request-body-source"]').exists()).toBe(false);
        await wrapper.get('[data-testid="api-request-empty-create"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="api-request-body-source"]').exists()).toBe(true);
        wrapper.unmount();
    });

    /**
     * task-34（用户报障 ②）：**进页即格式化 + 高亮**。
     *
     * <p>用户原话「JSON 仍然没有默认格式化以及 JSON 代码高亮」。旧实现只有一枚手点「格式化」
     * 按钮（无高亮）；换成 `JsonFieldEditor` 后，第一次拿到非空正文就按 2 空格格式化，
     * 并由 CodeMirror 提供语法高亮。</p>
     */
    /**
     * task-34（用户报障 ②）：**格式化与高亮都由编辑器负责**。
     *
     * <p>面板自身不再有「格式化」按钮（旧实现 `JSON.stringify(parsed, null, 2)`），改由
     * `JsonFieldEditor` 提供：它在第一次拿到非空正文时按 2 空格格式化一次，并渲染 CM6 高亮。
     * 这里钉两件事：① 点编辑器自带格式化后文档是 2 空格缩进；② 编辑器产生 highlight span。</p>
     */
    it("task-34: 编辑器自带格式化 + 高亮（面板不再自带格式化按钮）", async () => {
        const wrapper = mount(Panel, { props: { entries: {}, saving: false, layer: "user" } });
        await flushPromises();
        await wrapper.get('[data-testid="api-request-new"]').trigger("click");
        await flushPromises();
        const compact = '{"model":"${xh.model}","stream":true}';
        setJsonDoc(wrapper, "api-request-body-source", compact);
        await flushPromises();
        await wrapper.get('[data-testid="api-request-body-source-format"]').trigger("click");
        await flushPromises();

        const text = jsonDocText(wrapper, "api-request-body-source");
        expect(text).toBe(JSON.stringify(JSON.parse(compact), null, 2));
        expect(text.split("\n")[1]).toMatch(/^ {2}"/);
        expect(
            jsonEditorView(wrapper, "api-request-body-source").dom.querySelectorAll("span").length,
        ).toBeGreaterThan(0);
    });

    it("没有可用类型时 CTA 禁用（与工具栏同一判据）", async () => {
        vi.mocked(listApiInputTypes).mockResolvedValue({ types: [] } as Awaited<
            ReturnType<typeof listApiInputTypes>
        >);
        const wrapper = mountPanel();
        await flushPromises();
        const cta = wrapper.get('[data-testid="api-request-empty-create"]');
        expect(cta.attributes("disabled")).toBeDefined();
        wrapper.unmount();
    });
});
