import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import { api } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";
import ProviderRequestFingerprintPanel from "../ProviderRequestFingerprintPanel.vue";
import type {
    ProviderRequestFingerprintDiffView,
    ProviderRequestFingerprintView,
} from "../../../../types";

vi.mock("../../../../composables/api", () => ({
    api: {
        getRunProviderRequestFingerprint:
            vi.fn<
                (
                    runId: string,
                    options?: { against?: string },
                ) => Promise<ProviderRequestFingerprintView | ProviderRequestFingerprintDiffView>
            >(),
    },
}));

const getFingerprint = vi.mocked(api.getRunProviderRequestFingerprint);
/** The failed-read path logs a warning by design; keep that expected noise out of test output. */
const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASELINE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let wrapper: VueWrapper | null = null;

function document() {
    return {
        algo: "sha256",
        dispatchAttempt: 1,
        providerStep: 1,
        layers: {
            systemTemplate: { hash: "a".repeat(64), bytes: 900 },
            history: { hash: "b".repeat(64), count: 4, bytes: 2400 },
            userInput: { hash: "c".repeat(64), bytes: 120 },
            toolSchema: { hash: "d".repeat(64), count: 2, bytes: 300 },
            config: {
                hash: "e".repeat(64),
                bytes: 64,
                samplingKeys: ["temperature"],
                imageParts: 0,
            },
        },
        outbound: { hash: "f".repeat(64), bytes: 3800 },
    };
}

function requestMeta(overrides: Record<string, unknown> = {}) {
    return {
        apiTypeId: "openai-compatible",
        apiTypeVersion: 3,
        model: "wire-model",
        messageCount: 5,
        toolCount: 2,
        bytesTotal: 3800,
        dispatchAttempt: 1,
        providerStep: 1,
        roleHistogram: { human: 2, assistant: 2, tool: 1 },
        systemSources: {},
        ...overrides,
    };
}

function view(
    overrides: Partial<ProviderRequestFingerprintView> = {},
): ProviderRequestFingerprintView {
    return {
        runId: RUN_ID,
        available: true,
        fingerprint: document(),
        request: requestMeta(),
        ...overrides,
    };
}

function diffView(
    overrides: Partial<ProviderRequestFingerprintDiffView> = {},
): ProviderRequestFingerprintDiffView {
    return {
        againstRunId: BASELINE_ID,
        runId: RUN_ID,
        status: "comparable",
        against: requestMeta({ model: "old-model", toolCount: 1, bytesTotal: 3100 }),
        current: requestMeta(),
        layers: {
            systemTemplate: { layer: "systemTemplate", status: "unchanged" },
            history: {
                layer: "history",
                status: "changed(sameShape)",
                countDelta: 0,
                bytesDelta: 0,
            },
            userInput: { layer: "userInput", status: "changed(grew)", bytesDelta: 40 },
            toolSchema: { layer: "toolSchema", status: "added", countDelta: 1 },
            config: { layer: "config", status: "unchanged" },
        },
        outbound: { layer: "outbound", status: "changed(grew)", bytesDelta: 700 },
        dispatchAttempt: { against: 1, current: 1 },
        summary: { changedLayers: ["history", "userInput", "toolSchema"], unavailableLayers: [] },
        ...overrides,
    };
}

function mountPanel(runId = RUN_ID) {
    wrapper = mount(ProviderRequestFingerprintPanel, {
        props: {
            runId,
            againstOptions: [{ runId: BASELINE_ID, label: "success" }],
        },
        global: { plugins: [i18n] },
    });
    return wrapper;
}

beforeEach(() => {
    getFingerprint.mockResolvedValue(view());
});

afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.clearAllMocks();
    warnSpy.mockClear();
});

describe("ProviderRequestFingerprintPanel", () => {
    it("renders the six-layer fingerprint and request metadata for a captured run", async () => {
        mountPanel();
        await flushPromises();

        expect(getFingerprint).toHaveBeenCalledWith(RUN_ID, { against: undefined });
        expect(wrapper.find('[data-testid="provider-fingerprint-meta"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="provider-fingerprint-api-type"]').text()).toContain(
            "openai-compatible",
        );
        expect(wrapper.find('[data-testid="provider-fingerprint-model"]').text()).toBe(
            "wire-model",
        );

        for (const layer of [
            "systemTemplate",
            "history",
            "userInput",
            "toolSchema",
            "config",
            "outbound",
        ]) {
            const row = wrapper.find(`[data-testid="provider-fingerprint-layer-${layer}"]`);
            expect(row.exists(), `missing layer row ${layer}`).toBe(true);
            expect(row.text()).toContain(layer);
        }

        // Role histogram is rendered as count chips, never as prompt content.
        const roles = wrapper.find('[data-testid="provider-fingerprint-roles"]');
        expect(roles.text()).toContain("human");
        expect(roles.text()).toContain("2");

        // `outbound` lives beside `layers` in the document and must still show its hash.
        expect(
            wrapper.find('[data-testid="provider-fingerprint-layer-outbound"]').text(),
        ).toContain("ffffffff");
    });

    it("names absence instead of re-encoding it (two-level model, D5)", async () => {
        getFingerprint.mockResolvedValue({
            runId: RUN_ID,
            available: false,
            reason: "not_captured",
        });
        mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="provider-fingerprint-not-captured"]').exists()).toBe(
            true,
        );
        expect(wrapper.find('[data-testid="provider-fingerprint-meta"]').exists()).toBe(false);
    });

    it("shows the fail-open error marker instead of a fake fingerprint", async () => {
        getFingerprint.mockResolvedValue(
            view({
                fingerprint: { status: "error", reasonCode: "FINGERPRINT_TOO_LARGE" },
                request: requestMeta(),
            }),
        );
        mountPanel();
        await flushPromises();

        const error = wrapper.find('[data-testid="provider-fingerprint-error"]');
        expect(error.exists()).toBe(true);
        expect(error.text()).toContain("FINGERPRINT_TOO_LARGE");
        expect(wrapper.find('[data-testid="provider-fingerprint-layer-history"]').exists()).toBe(
            false,
        );
    });

    it("keeps a retry path when the read fails and refetches on demand", async () => {
        getFingerprint.mockRejectedValueOnce(new Error("boom"));
        mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="provider-fingerprint-retry"]').exists()).toBe(true);
        getFingerprint.mockResolvedValueOnce(view());
        await wrapper.find('[data-testid="provider-fingerprint-retry"]').trigger("click");
        await flushPromises();

        expect(getFingerprint).toHaveBeenCalledTimes(2);
        expect(wrapper.find('[data-testid="provider-fingerprint-meta"]').exists()).toBe(true);
    });

    it("renders the two-run layer diff with per-layer verdicts after picking a baseline", async () => {
        getFingerprint.mockResolvedValueOnce(view()).mockResolvedValueOnce(diffView());
        mountPanel();
        await flushPromises();

        await wrapper
            .find('[data-testid="provider-fingerprint-against-select"]')
            .setValue(BASELINE_ID);
        await flushPromises();

        expect(getFingerprint).toHaveBeenLastCalledWith(RUN_ID, { against: BASELINE_ID });
        expect(wrapper.find('[data-testid="provider-fingerprint-diff-meta"]').exists()).toBe(true);
        // Labels go through i18n, so compare with the same lookup instead of a locale literal.
        expect(
            wrapper.find('[data-testid="provider-fingerprint-diff-layer-history"]').text(),
        ).toContain(i18n.global.t("monitor.fingerprint.status.changed(sameShape)"));
        expect(
            wrapper.find('[data-testid="provider-fingerprint-diff-layer-toolSchema"]').text(),
        ).toContain(i18n.global.t("monitor.fingerprint.status.added"));
        expect(
            wrapper.find('[data-testid="provider-fingerprint-diff-layer-outbound"]').text(),
        ).toContain("+700");
        // Single-run table must be gone once the diff view takes over.
        expect(wrapper.find('[data-testid="provider-fingerprint-layer-history"]').exists()).toBe(
            false,
        );
    });

    it("refetches when the selected run changes", async () => {
        mountPanel();
        await flushPromises();
        getFingerprint.mockResolvedValue(
            view({
                runId: BASELINE_ID,
                available: false,
                reason: "not_captured",
                fingerprint: null,
                request: null,
            }),
        );

        await wrapper.setProps({
            runId: BASELINE_ID,
            againstOptions: [{ runId: RUN_ID, label: "success" }],
        });
        await flushPromises();

        expect(getFingerprint).toHaveBeenLastCalledWith(BASELINE_ID, { against: undefined });
        expect(wrapper.find('[data-testid="provider-fingerprint-not-captured"]').exists()).toBe(
            true,
        );
    });
});
