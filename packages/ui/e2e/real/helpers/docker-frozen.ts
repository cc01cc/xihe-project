/**
 * PLAN-0618: the workspace docker backend is frozen, so specs/cases that can only be meaningful with a
 * real container are skipped with a visible "DOCKER_FROZEN" reason instead of being deleted. Recovery is
 * one switch: `node scripts/e2e-host.mjs --include-docker-frozen ...` (sets
 * XIHE_E2E_INCLUDE_DOCKER_FROZEN=1). A skipped case shows as skipped in the report, never as passed.
 *
 * Inventory: plans/PLAN-0618-XH-docker-freeze-complete/evidence/m3-frozen-tests.md
 */
export const dockerFrozenIncluded = process.env.XIHE_E2E_INCLUDE_DOCKER_FROZEN === "1";

/** Reason string for `test.skip` / `test.describe.skip`; includes what the case verifies once thawed. */
export function dockerFrozenReason(whatItVerifies: string): string {
    return (
        "DOCKER_FROZEN (PLAN-0618): needs the workspace docker execution backend, which is frozen. " +
        "Thawed, this verifies: " +
        whatItVerifies
    );
}
