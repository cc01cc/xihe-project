import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import GuidancePanel from "../components/GuidancePanel.vue";
import { i18n } from "../../../../i18n";
import { ApiError, type ChatRunGuidanceSnapshot } from "../../../../composables/api";
import * as apiModule from "../../../../composables/api";

/**
 * PLAN-0530 spec §3.2/§3.3 (PLAN-0536 A-class fix): a successful submit and the
 * frozen `409 GUIDANCE_RUN_NOT_ACTIVE` clear the draft; every other failure keeps
 * the user's text. The browser journey cannot assert the draft because the input
 * unmounts once the Run leaves the active set, so this is the observable proof.
 */
const RUN_ID = "33333333-3333-4333-8333-333333333333";

const { submitMock, snapshotMock } = vi.hoisted(() => ({
    submitMock:
        vi.fn<(runId: string, content: string, idempotencyKey: string) => Promise<unknown>>(),
    snapshotMock: vi.fn<(runId: string) => Promise<ChatRunGuidanceSnapshot>>(),
}));

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            submitChatRunGuidance: submitMock,
            getChatRunGuidance: snapshotMock,
        },
    };
});

function emptySnapshot(): ChatRunGuidanceSnapshot {
    return { items: [], latestSequence: 0 } as ChatRunGuidanceSnapshot;
}

function problem(status: number): ApiError {
    return new ApiError({
        status,
        code: "GUIDANCE_RUN_NOT_ACTIVE",
        detail: "rejected",
        requestId: "t",
    });
}

function mountPanel(runStatus = "awaiting_approval") {
    return mount(GuidancePanel, {
        props: { runId: RUN_ID, runStatus },
        global: { plugins: [i18n] },
    });
}

async function submitText(wrapper: ReturnType<typeof mountPanel>, text: string) {
    const input = wrapper.get('[data-testid="guidance-input"]');
    await input.setValue(text);
    await wrapper.get('[data-testid="guidance-submit"]').trigger("click");
    await flushPromises();
}

describe("GuidancePanel draft handling", () => {
    beforeEach(() => {
        submitMock.mockReset();
        snapshotMock.mockReset();
        snapshotMock.mockResolvedValue(emptySnapshot());
    });

    it("clears the draft after a successful submission", async () => {
        submitMock.mockResolvedValue({ id: "guidance-1", status: "pending" });
        const wrapper = mountPanel();
        await flushPromises();

        await submitText(wrapper, "keep the smaller change");

        expect(submitMock).toHaveBeenCalledTimes(1);
        expect(
            (wrapper.get('[data-testid="guidance-input"]').element as HTMLTextAreaElement).value,
        ).toBe("");
    });

    it("clears the draft and shows the banner on the frozen 409", async () => {
        submitMock.mockRejectedValue(problem(409));
        const wrapper = mountPanel();
        await flushPromises();

        await submitText(wrapper, "race guidance");

        const banner = wrapper.get('[data-testid="guidance-banner-error"]');
        expect(banner.text()).toContain("Run 已结束或不再接受指导");
        expect(
            (wrapper.get('[data-testid="guidance-input"]').element as HTMLTextAreaElement).value,
        ).toBe("");
        expect(wrapper.findAll('[data-testid="guidance-list"] li')).toHaveLength(0);
    });

    it("keeps the draft when the submission fails for another reason", async () => {
        submitMock.mockRejectedValue(problem(500));
        const wrapper = mountPanel();
        await flushPromises();

        await submitText(wrapper, "keep my text");

        expect(wrapper.get('[data-testid="guidance-banner-error"]').text()).toContain("服务异常");
        expect(
            (wrapper.get('[data-testid="guidance-input"]').element as HTMLTextAreaElement).value,
        ).toBe("keep my text");
    });
});
