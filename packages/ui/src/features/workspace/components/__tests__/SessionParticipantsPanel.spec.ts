import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createPinia } from "pinia";
import { i18n } from "../../../../i18n";
import SessionParticipantsPanel from "../SessionParticipantsPanel.vue";
import type { SessionParticipantView } from "../../../../types/participant";

const AGENT: SessionParticipantView = {
    participantId: "p-agent",
    principalKind: "AGENT",
    principalId: "9f1d0c1e-1111-4111-8111-aaaaaaaaaaaa",
    displayName: "Research Agent",
    role: "PRIMARY",
    orderIndex: 10,
    wakePolicy: "ALL_MESSAGES",
    respondPolicy: "ALWAYS",
    source: "workspace",
    disabledAt: null,
    readCursor: { lastReadEventSeq: 12, mentionCount: 3, updatedAt: "2026-11-02T00:00:00Z" },
};

const HUMAN: SessionParticipantView = {
    participantId: "p-human",
    principalKind: "HUMAN",
    principalId: "5a2b7c9d-2222-4222-8222-bbbbbbbbbbbb",
    displayName: "Ada Lovelace",
    role: "MEMBER",
    orderIndex: 20,
    wakePolicy: "MENTION",
    respondPolicy: "WHEN_MENTIONED",
    source: null,
    disabledAt: null,
    readCursor: null,
};

function mountPanel(props: Record<string, unknown> = {}) {
    return mount(SessionParticipantsPanel, {
        props: { sessionId: "session-1", participants: null, ...props },
        global: { plugins: [i18n, createPinia()] },
    });
}

describe("SessionParticipantsPanel (PLAN-0623)", () => {
    it("renders nothing while the participant data source is not wired (no fake empty list)", () => {
        const wrapper = mountPanel({ participants: null });

        expect(wrapper.find('[data-testid="session-participants-panel"]').exists()).toBe(true);
        // 未接入 ≠ 空列表：既不显示"没有参与者"，也不显示临时的 pending 文案。
        expect(wrapper.find('[data-testid="participants-empty"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="participants-pending"]').exists()).toBe(false);
        expect(wrapper.findAll('[data-testid^="participant-row-"]')).toHaveLength(0);
    });

    it("shows the empty state only for a real empty list", () => {
        const wrapper = mountPanel({ participants: [] });
        expect(wrapper.find('[data-testid="participants-empty"]').exists()).toBe(true);
    });

    it("renders one row per participant with kind, role and policy indicators", () => {
        const wrapper = mountPanel({ participants: [AGENT, HUMAN] });

        const rows = wrapper.findAll('[data-testid^="participant-row-"]');
        expect(rows).toHaveLength(2);

        const agentRow = wrapper.get('[data-testid="participant-row-p-agent"]');
        expect(agentRow.get('[data-testid="participant-initials-p-agent"]').text()).toBe("RA");
        expect(
            agentRow
                .get('[data-testid="participant-kind-badge-p-agent"]')
                .attributes("data-participant-kind"),
        ).toBe("AGENT");
        expect(
            agentRow
                .get('[data-testid="participant-role-badge-p-agent"]')
                .attributes("data-session-role"),
        ).toBe("PRIMARY");
        expect(agentRow.get('[data-testid="participant-wake-indicator-p-agent"]').exists()).toBe(
            true,
        );
        expect(agentRow.get('[data-testid="participant-respond-indicator-p-agent"]').exists()).toBe(
            true,
        );
        // 未读/@我 只在服务端游标给出非零 mentionCount 时才出现。
        expect(agentRow.get('[data-testid="participant-mention-badge-p-agent"]').text()).toContain(
            "3",
        );

        const humanRow = wrapper.get('[data-testid="participant-row-p-human"]');
        expect(humanRow.get('[data-testid="participant-initials-p-human"]').text()).toBe("AL");
        expect(
            humanRow
                .get('[data-testid="participant-kind-badge-p-human"]')
                .attributes("data-participant-kind"),
        ).toBe("HUMAN");
        expect(humanRow.find('[data-testid="participant-disabled-badge-p-human"]').exists()).toBe(
            false,
        );
        // mentionCount 缺失 ⇒ 不渲染计数，也不用 0 冒充。
        expect(humanRow.find('[data-testid="participant-mention-badge-p-human"]').exists()).toBe(
            false,
        );
    });

    it("marks a disabled participant and keeps the row visible", () => {
        const wrapper = mountPanel({
            participants: [{ ...HUMAN, disabledAt: "2026-11-02T01:00:00Z" }],
        });
        const row = wrapper.get('[data-testid="participant-row-p-human"]');
        expect(row.get('[data-testid="participant-disabled-badge-p-human"]').exists()).toBe(true);
    });
});
