import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { i18n } from "../../../../../i18n";
import { api } from "../../../../../composables/api";
import type * as apiModule from "../../../../../composables/api";
import { useDelegationPermission } from "../useDelegationPermission";

vi.mock("../../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

const WORKSPACE_ID = "ws-delegation-1";

/**
 * task-905: CP materializes canonical `action:` atom names (task-835), but this composable
 * compared the bare `SPAWN_AGENT` string. Unlike the task-902 path it does not read the
 * auth-store atom sets, so the comparison has to normalize at this read boundary too.
 */
function probe() {
    const snapshot = { canDelegate: false };
    const Probe = defineComponent({
        setup() {
            const gate = useDelegationPermission(() => WORKSPACE_ID);
            return () => {
                snapshot.canDelegate = gate.canDelegate.value;
                return h("i");
            };
        },
    });
    const wrapper = mount(Probe, { global: { plugins: [i18n] } });
    return { snapshot, wrapper };
}

async function canDelegateWith(permissions: Array<{ actionClass: string; resource: string }>) {
    mockedApi.getSelfPermissions.mockResolvedValue({
        userId: "user-1",
        instanceCapabilities: [],
        instancePermissions: [],
        workspaces: [{ workspaceId: WORKSPACE_ID, permissions }],
    });
    const { snapshot, wrapper } = probe();
    await flushPromises();
    wrapper.unmount();
    return snapshot.canDelegate;
}

describe("useDelegationPermission atom names", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("enables delegation for the canonical action:SPAWN_AGENT projection (task-905)", async () => {
        expect(await canDelegateWith([{ actionClass: "action:SPAWN_AGENT", resource: "*" }])).toBe(
            true,
        );
    });

    it("keeps legacy bare SPAWN_AGENT working (task-905)", async () => {
        expect(await canDelegateWith([{ actionClass: "SPAWN_AGENT", resource: "*" }])).toBe(true);
    });

    it("never treats a capability atom as the SPAWN_AGENT action atom (task-905)", async () => {
        expect(await canDelegateWith([{ actionClass: "cap:workspace:admin", resource: "*" }])).toBe(
            false,
        );
    });
});
