import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SessionTierSelect from "../components/SessionTierSelect.vue";
import { i18n } from "../../../../i18n";
import type * as apiModule from "../../../../composables/api";
import { useAuthStore } from "../../../../stores/auth";

/**
 * task-1025（F22）：新会话默认「仅可查看 · 继承中」且工作区没设默认值时，
 * 必须说清默认值来源，并提示「Agent 默认只读，可在此调整」。
 *
 * 两种形态都要能通过触发按钮的 accessible description 读到（compact 走 aria-describedby
 * 指向 sr-only 提示，面板走常显回落说明），不能只靠 hover title。
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
            getSessionTier: getSessionTierMock,
            setSessionTier: setSessionTierMock,
        },
    };
});

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const translate = i18n.global.t as unknown as (
    key: string,
    named?: Record<string, unknown>,
) => string;

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

async function mountSelect(compact: boolean) {
    const wrapper = mount(SessionTierSelect, {
        props: { sessionId: SESSION_ID, compact },
        global: { plugins: [i18n] },
    });
    await flushPromises();
    return wrapper;
}

function describedByText(wrapper: Awaited<ReturnType<typeof mountSelect>>, testid: string) {
    const trigger = wrapper.get(`[data-testid="${testid}"]`);
    const describedBy = trigger.attributes("aria-describedby");
    expect(describedBy, "触发按钮必须有 accessible description").toBeTruthy();
    return wrapper.get(`[id="${describedBy}"]`).text();
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    useAuthStore().$patch({
        workspace: {
            id: "workspace-1",
            name: "Workspace",
            workspaceRole: "EDITOR",
            canWrite: true,
        },
    });
    getSessionTierMock.mockResolvedValue(tierState());
});

describe("task-1025 · 默认档位来源与只读提示可读", () => {
    it("面板形态：无工作区默认值 + 只读档 ⇒ describedby 含来源与「默认只读」", async () => {
        getSessionTierMock.mockResolvedValue(
            tierState({ tier: "view", source: "none", workspaceTier: null }),
        );

        const wrapper = await mountSelect(false);
        const text = describedByText(wrapper, "session-tier-select");

        expect(text).toContain(translate("sessionSettings.tierNoWorkspaceDefault"));
        expect(text).toContain(translate("sessionSettings.tierAgentDefaultReadOnly"));
        wrapper.unmount();
    });

    it("compact 形态：同一判据进 sr-only 提示，经 aria-describedby 可达", async () => {
        getSessionTierMock.mockResolvedValue(
            tierState({ tier: "view", source: "none", workspaceTier: null }),
        );

        const wrapper = await mountSelect(true);
        const text = describedByText(wrapper, "composer-tier-chip");

        expect(text).toContain(translate("sessionSettings.tierNoWorkspaceDefault"));
        expect(text).toContain(translate("sessionSettings.tierAgentDefaultReadOnly"));
        wrapper.unmount();
    });

    it("有工作区默认值时不得出现回落说明（不误报）", async () => {
        getSessionTierMock.mockResolvedValue(tierState());

        const wrapper = await mountSelect(false);
        expect(wrapper.find('[data-testid="session-tier-fallback"]').exists()).toBe(false);
        expect(
            wrapper.get('[data-testid="session-tier-select"]').attributes("aria-describedby"),
        ).toBeUndefined();
        wrapper.unmount();
    });
});
