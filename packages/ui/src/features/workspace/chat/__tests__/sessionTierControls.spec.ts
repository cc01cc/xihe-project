import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";
import SessionContextPanel from "../../components/SessionContextPanel.vue";
import SessionSettingsPanel from "../components/SessionSettingsPanel.vue";
import { i18n } from "../../../../i18n";
import { api, ApiError } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { useSessionStore } from "../../../../stores/session";
import { useAuthStore } from "../../../../stores/auth";
import {
    openSelect,
    selectItemComponents,
    selectItemTextsFor,
    selectItemValuesFor,
    selectModelValue,
    setSelectValue,
} from "../../../../test-utils/select";

/**
 * D-1908（DSD id=1448，2026-11-19 登记）会话权限三档 —— 界面契约的**先发测试**。
 *
 * 本 spec 是「先红后绿」的前置件（task-123）：实现卡是 task-109（面板改造），
 * 文案来源是 task-115 的三语草案（本仓只有 zh-CN / en-US 两语，第三语不存在）。
 * 六组用例逐条对应 D-1908 条款，注释里写了条款号。
 *
 * ============================================================
 * 假定契约（task-109 / CP 侧 task-107 + task-108 须按此对齐）
 * ============================================================
 * API（`src/composables/api.ts` 现无 tier 函数，落实现时按此命名）：
 *
 *   GET  /api/v1/sessions/{id}/tier   -> api.getSessionTier(sessionId): Promise<SessionTierState>
 *   PATCH /api/v1/sessions/{id}/tier  -> api.setSessionTier(sessionId, tier): Promise<SessionTierState>
 *
 *   interface SessionTierState {
 *       tier: "view" | "workspace" | "full";        // 生效档位（已按「取严」求值）
 *       source: "session" | "workspace" | "none";   // 来源：会话覆盖 / 工作区默认 / 无默认值
 *       workspaceTier: SessionTier | null;          // 工作区默认档（无默认值时为 null）
 *       canConfigure: boolean;                      // 能力原子 session:permission:configure + owner scope
 *       denyReason: "viewer" | "not-owner" | "no-atom" | null;
 *       available: SessionTier[];                   // 该工作区执行方式下允许的档位（越层项不在此列）
 *   }
 *
 * DOM（testid 全为新增，未与既有 testid 冲突；D26-09 要求唯一）：
 *   session-tier-select       三档选择器（唯--个；取代原独立审批模式下拉）
 *   session-tier-badge        继承/覆盖徽标（摘要行；BL-311：无权限时仍可见）
 *   session-tier-readonly     只读原因说明（可见文本，非仅 title）
 *   session-tier-unsupported  越层说明（常显，不只 tooltip）
 *   session-tier-fallback     无工作区默认值时的回落提示（可见）
 *   session-tier-error        改档失败的内联错误
 */

type SessionTier = "view" | "workspace" | "full";
type TierSource = "session" | "workspace" | "none";

interface SessionTierState {
    tier: SessionTier;
    source: TierSource;
    workspaceTier: SessionTier | null;
    canConfigure: boolean;
    denyReason: "viewer" | "not-owner" | "no-atom" | null;
    available: SessionTier[];
}

interface TierApi {
    getSessionTier: (sessionId: string) => Promise<SessionTierState>;
    setSessionTier: (sessionId: string, tier: SessionTier) => Promise<SessionTierState>;
}

const { getSessionTierMock, setSessionTierMock } = vi.hoisted(() => ({
    getSessionTierMock: vi.fn<(sessionId: string) => Promise<SessionTierState>>(),
    setSessionTierMock:
        vi.fn<(sessionId: string, tier: SessionTier) => Promise<SessionTierState>>(),
}));

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getPolicyMode: vi.fn<typeof apiModule.api.getPolicyMode>(),
            setPolicyMode: vi.fn<typeof apiModule.api.setPolicyMode>(),
            getSessionTier: getSessionTierMock,
            setSessionTier: setSessionTierMock,
        },
    };
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

// i18n 的 t 有多套重载，取字符串键形态即可（断言的是「文案来自 i18n」而非字面量）。
const translate = i18n.global.t as unknown as (
    key: string,
    named?: Record<string, unknown>,
) => string;

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOT_BRANCH_ID = "44444444-4444-4444-8444-444444444444";
const TIER_SELECT = '[data-testid="session-tier-select"]';
const TIER_BADGE = '[data-testid="session-tier-badge"]';

const tierApi = api as unknown as TierApi;

const TierApiError = ApiError;

function tierState(overrides: Partial<SessionTierState> = {}): SessionTierState {
    return {
        tier: "workspace",
        source: "workspace",
        workspaceTier: "workspace",
        canConfigure: true,
        denyReason: null,
        available: ["view", "workspace", "full"],
        ...overrides,
    };
}

const tierLabel = (tier: SessionTier): string =>
    translate(
        tier === "view"
            ? "sessionSettings.tierView"
            : tier === "workspace"
              ? "sessionSettings.tierWorkspace"
              : "sessionSettings.tierFull",
    );

const SessionContextPanelStub = defineComponent({
    setup: () => () => h("div", { "data-testid": "session-context-panel-stub" }),
});

const TemplateStub = defineComponent({
    setup: () => () => h("div", { "data-testid": "stub-context-template" }),
});

const ContextSourcesStub = defineComponent({
    setup: () => () => h("div", { "data-testid": "stub-context-sources" }),
});

function seedSession() {
    useSessionStore().sessions = [
        {
            id: SESSION_ID,
            title: "Session",
            createdAt: "2026-11-19T00:00:00Z",
            updatedAt: "2026-11-19T00:00:00Z",
            workspaceId: "workspace-1",
            contextTemplateLayer: null,
            contextTemplateId: null,
            contextTemplateVersion: null,
        },
    ];
}

/** 三档选择器落在 dock 的会话上下文档（桌面端不渲染在 SessionSettingsPanel 里）。 */
function mountSelectorPanel() {
    return mount(SessionContextPanel, {
        props: { sessionId: SESSION_ID },
        global: {
            plugins: [i18n],
            stubs: {
                SessionContextTemplate: TemplateStub,
                ContextSourcesU1: ContextSourcesStub,
                SessionSettingsPanel: SessionContextPanelStub,
            },
        },
    });
}

/** 摘要徽标落在聊天列底部的会话设置条（折叠态摘要行）。 */
function mountSummaryPanel() {
    return mount(SessionSettingsPanel, {
        props: {
            sessionId: SESSION_ID,
            branchOptions: [{ branchId: ROOT_BRANCH_ID, label: "主路径" }],
            selectedBranchId: ROOT_BRANCH_ID,
            mainBranchId: ROOT_BRANCH_ID,
            isMobile: false,
        },
        global: {
            plugins: [i18n],
            stubs: {
                SessionContextPanel: SessionContextPanelStub,
                SessionContextTemplate: TemplateStub,
            },
        },
    });
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    seedSession();
    useAuthStore().$patch({
        workspace: {
            id: "workspace-1",
            name: "Workspace",
            workspaceRole: "EDITOR",
            canWrite: true,
        },
    });
    getSessionTierMock.mockResolvedValue(tierState());
    setSessionTierMock.mockImplementation((_sessionId, tier) =>
        Promise.resolve(tierState({ tier, source: "session" })),
    );
});

describe("D-1908 二/七 · 三档选择器取代独立审批模式下拉", () => {
    it("在会话设置里只渲染一个 tier 选择器，且不再有『审批模式』下拉", async () => {
        const wrapper = mountSelectorPanel();
        await flushPromises();

        expect(wrapper.findAll(TIER_SELECT)).toHaveLength(1);
        // 旧形态的两个锚点都必须消失：旧控件的 testid 与其 aria-label 文案。
        expect(wrapper.find('[data-testid="session-policy-mode"]').exists()).toBe(false);
        // 注意：这里断言的是「没有独立的下拉」，不是「文案不存在」——摘要行会显示
        // 档位标签，因此只钉 aria-label 这个选择器锚点（旧控件用 aria-label 命名）。
        expect(
            wrapper.findAll(
                `[role="combobox"][aria-label="${translate("chat.approvalModeLabel")}"]`,
            ).length,
        ).toBe(0);
    });

    it("提供且只提供三档，label 全部取自 sessionSettings.*（不硬编码中文）", async () => {
        const wrapper = mountSelectorPanel();
        await flushPromises();

        await openSelect(wrapper, TIER_SELECT);

        expect(selectItemValuesFor(wrapper, TIER_SELECT)).toEqual(["view", "workspace", "full"]);
        expect(selectItemTextsFor(wrapper, TIER_SELECT)).toEqual([
            tierLabel("view"),
            tierLabel("workspace"),
            tierLabel("full"),
        ]);
        expect(selectItemComponents(wrapper)).toHaveLength(3);
        expect(translate("sessionSettings.tierLabel").length).toBeGreaterThan(0);
    });
});

describe("D-1908 一 · 继承来源徽标三态（+ 无工作区默认值的降级形态）", () => {
    it("继承态：徽标写『继承中 · 工作区默认：X』，选择器显示继承值本身", async () => {
        const summary = mountSummaryPanel();
        const selector = mountSelectorPanel();
        await flushPromises();

        expect(summary.get(TIER_BADGE).text()).toBe(
            translate("sessionSettings.tierInherited", { tier: tierLabel("workspace") }),
        );
        // 选择器显示的是继承来的值（不是空、不是占位），用户才看得出「当前是什么态」。
        expect(selectModelValue(selector, TIER_SELECT)).toBe("workspace");
        expect(summary.find('[data-testid="session-tier-fallback"]').exists()).toBe(false);
    });

    it("覆盖态：徽标写『会话覆盖：X』", async () => {
        getSessionTierMock.mockResolvedValue(
            tierState({ tier: "full", source: "session", workspaceTier: "view" }),
        );

        const summary = mountSummaryPanel();
        const selector = mountSelectorPanel();
        await flushPromises();

        expect(summary.get(TIER_BADGE).text()).toBe(
            translate("sessionSettings.tierOverride", { tier: tierLabel("full") }),
        );
        expect(selectModelValue(selector, TIER_SELECT)).toBe("full");
    });

    it("无工作区默认值：徽标降级、回落最严档并给出可见提示（不静默）", async () => {
        getSessionTierMock.mockResolvedValue(
            tierState({ tier: "view", source: "none", workspaceTier: null }),
        );

        const summary = mountSummaryPanel();
        const selector = mountSelectorPanel();
        await flushPromises();

        expect(summary.get(TIER_BADGE).text()).toBe(
            translate("sessionSettings.tierNoWorkspaceDefault"),
        );
        // 回落取严：无默认值 ⇒ "view"，不能取 full。
        expect(selectModelValue(selector, TIER_SELECT)).toBe("view");
        const fallback = selector.get('[data-testid="session-tier-fallback"]');
        expect(fallback.text().trim().length).toBeGreaterThan(0);
        expect(fallback.isVisible()).toBe(true);
    });
});

describe("D-1908 三/七 · 越层禁选（工作区执行方式不支持更高档）", () => {
    it("不支持的档位 disabled 并带原因，选了也不发请求、值不变", async () => {
        getSessionTierMock.mockResolvedValue(
            tierState({ tier: "workspace", source: "workspace", available: ["view", "workspace"] }),
        );

        const wrapper = mountSelectorPanel();
        await flushPromises();

        await openSelect(wrapper, TIER_SELECT);
        const items = selectItemComponents(wrapper);
        const fullItem = items.find((item) => item.props("value") === "full");
        expect(fullItem).toBeDefined();
        expect(fullItem!.props("disabled")).toBe(true);
        expect(fullItem!.text()).toContain(tierLabel("full"));

        // 常显说明行（不只 tooltip）：用户不该靠悬停才能知道为什么点不了。
        expect(wrapper.find('[data-testid="session-tier-unsupported"]').exists()).toBe(true);

        const before = selectModelValue(wrapper, TIER_SELECT);
        // 走 Select 的 update:modelValue 路径，模拟「用户强行选了被禁项」。
        await setSelectValue(wrapper, TIER_SELECT, "full");
        await flushPromises();
        expect(tierApi.setSessionTier).not.toHaveBeenCalled();
        expect(selectModelValue(wrapper, TIER_SELECT)).toBe(before);
    });
});

describe("D-1908 三 · 无权限（缺 session:permission:configure / 非 owner / 只读）", () => {
    it("无权限时选择器 disabled 但仍可见，并显示原因（BL-311 不许隐藏）", async () => {
        getSessionTierMock.mockResolvedValue(
            tierState({ canConfigure: false, denyReason: "no-atom" }),
        );

        const selector = mountSelectorPanel();
        const summary = mountSummaryPanel();
        await flushPromises();

        const trigger = selector.get(TIER_SELECT);
        expect(trigger.attributes("disabled")).toBeDefined();
        expect(trigger.isVisible()).toBe(true);
        expect(selector.get('[data-testid="session-tier-readonly"]').text()).toContain(
            translate("sessionSettings.tierReasonNoAtom"),
        );
        expect(summary.get(TIER_BADGE).text()).toContain(
            translate("sessionSettings.tierReasonNoAtom"),
        );
    });
});

describe("D-1908 七 · 改档只发一次 PATCH，失败回滚并显示可读文案", () => {
    it("成功路径：一次 PATCH，参数为 (sessionId, tier)", async () => {
        const wrapper = mountSelectorPanel();
        await flushPromises();

        await setSelectValue(wrapper, TIER_SELECT, "full");
        await flushPromises();

        expect(tierApi.setSessionTier).toHaveBeenCalledTimes(1);
        expect(tierApi.setSessionTier).toHaveBeenCalledWith(SESSION_ID, "full");
    });

    it("失败路径：回滚到原档位，错误文案可读且不含错误码/英文 detail", async () => {
        setSessionTierMock.mockRejectedValue(
            new TierApiError({
                status: 403,
                code: "SESSION_TIER_FORBIDDEN",
                detail: "session:permission:configure is required",
                requestId: "req-1",
            }),
        );

        const wrapper = mountSelectorPanel();
        await flushPromises();

        await setSelectValue(wrapper, TIER_SELECT, "full");
        await flushPromises();

        expect(tierApi.setSessionTier).toHaveBeenCalledTimes(1);
        // 回滚：模型值回到继承来的 "workspace"，不能停在乐观的 "full"。
        expect(selectModelValue(wrapper, TIER_SELECT)).toBe("workspace");
        const error = wrapper.get('[data-testid="session-tier-error"]').text();
        expect(error.trim().length).toBeGreaterThan(0);
        expect(error).not.toContain("SESSION_TIER_FORBIDDEN");
        expect(error).not.toContain("session:permission:configure is required");
        expect(error).not.toMatch(/API error \d+/);
    });
});
