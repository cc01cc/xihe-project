// task-117 (DSD-1501): the host-E2E PostgreSQL readiness gate decides freshness by
// **container identity**, not by the wall clock.
//
// Why this exists: the previous judge was `Date.parse(State.StartedAt) >= startedAtMs - 2s`
// with `startedAtMs = Date.now()` on the host. Docker Desktop reports `StartedAt` from its
// WSL2 VM clock, so any host clock drift makes the container look older than the `up` that
// created it. Measured 2026-11-20 on this host: Windows host ~+5 s vs three independent
// HTTP Date headers, docker container ~true time ⇒ the gate rejected a perfectly healthy
// container every single run (task-27: two runs, exit 1, zero tests executed).
//
// `docker compose up --force-recreate` always replaces the container, so the container id
// is the clock-free witness of "this is the instance I just created": a changed id means
// fresh, an unchanged id means we are looking at the previous round's container.
//
// Fail-closed: an unknown/empty current id is never fresh — a gate that cannot identify the
// instance must not pass it (task-237's original intent: never boot CP against an
// unpublishable/older container).

const ID_MISSING = 'id-missing'
const NO_PRIOR_CONTAINER = 'no-prior-container'
const INSTANCE_REPLACED = 'instance-replaced'
const SAME_INSTANCE = 'same-instance'

export const PG_FRESHNESS_REASONS = Object.freeze({
    ID_MISSING,
    NO_PRIOR_CONTAINER,
    INSTANCE_REPLACED,
    SAME_INSTANCE,
})

function normalizeId(value) {
    if (typeof value !== 'string') return ''
    return value.trim().toLowerCase()
}

/**
 * @param {{ id?: string, priorId?: string }} [input] container id read after `up` and the
 *   id observed before `up` (empty string / undefined when no container existed).
 * @returns {{ fresh: boolean, reason: string }}
 */
export function evaluatePgInstanceFreshness({ id, priorId } = {}) {
    const currentId = normalizeId(id)
    const prior = normalizeId(priorId)
    if (currentId === '') return { fresh: false, reason: ID_MISSING }
    if (prior === '') return { fresh: true, reason: NO_PRIOR_CONTAINER }
    if (currentId === prior) return { fresh: false, reason: SAME_INSTANCE }
    return { fresh: true, reason: INSTANCE_REPLACED }
}
