// PLAN-0525 decision #9: bounded acceptance test for the Agent readiness gate.
// Deterministic and side-effect free — the health endpoint, clock and sleep are
// injected, so nothing binds a port and no stack starts.
//
//   node --test scripts/e2e-host-readiness.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { waitForAgentLlmReady } from './lib/agent-readiness.mjs'

const HEALTH = 'http://127.0.0.1:0/internal/v1/agent/health'

function fakeClock() {
    let current = 0
    return {
        now: () => current,
        sleep: async (ms) => {
            current += ms
        },
    }
}

function healthFetch(states) {
    let index = 0
    return async () => {
        const state = states[Math.min(index, states.length - 1)]
        index += 1
        if (state instanceof Error) throw state
        if (state.status !== 200) return { ok: false, status: state.status, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => ({ llmReady: state.llmReady }) }
    }
}

test('expected-ready lane returns once the Agent reports llmReady=ready', async () => {
    const { now, sleep } = fakeClock()
    const result = await waitForAgentLlmReady({
        healthUrl: HEALTH,
        expectReady: true,
        timeoutMs: 10000,
        pollMs: 1000,
        now,
        sleep,
        fetchImpl: healthFetch([{ status: 200, llmReady: 'missing_credentials' }, { status: 200, llmReady: 'ready' }]),
    })
    assert.equal(result.ready, true)
    assert.equal(result.lastState, 'llmReady=ready')
})

test('expected-ready lane fails closed when the budget is exhausted (Playwright must not start)', async () => {
    const { now, sleep } = fakeClock()
    await assert.rejects(
        waitForAgentLlmReady({
            healthUrl: HEALTH,
            expectReady: true,
            timeoutMs: 5000,
            pollMs: 2000,
            now,
            sleep,
            fetchImpl: healthFetch([{ status: 200, llmReady: 'missing_credentials' }]),
        }),
        (error) => {
            assert.match(error.message, /did not report llmReady=ready within 5000ms/)
            assert.match(error.message, /refusing to start Playwright/)
            assert.match(error.message, /llmReady=missing_credentials/)
            return true
        },
    )
    assert.ok(now() >= 5000, 'the deadline is actually reached before failing')
})

test('expected-ready lane fails closed when health is unreachable', async () => {
    const { now, sleep } = fakeClock()
    await assert.rejects(
        waitForAgentLlmReady({
            healthUrl: HEALTH,
            expectReady: true,
            timeoutMs: 3000,
            pollMs: 1000,
            now,
            sleep,
            fetchImpl: healthFetch([new Error('connect ECONNREFUSED')]),
        }),
        /health unreachable/,
    )
})

test('the intentional `missing` lane stays not-ready without burning the budget', async () => {
    const { now, sleep } = fakeClock()
    let calls = 0
    const result = await waitForAgentLlmReady({
        healthUrl: HEALTH,
        expectReady: false,
        timeoutMs: 480000,
        now,
        sleep,
        fetchImpl: async () => {
            calls += 1
            return { ok: true, status: 200, json: async () => ({ llmReady: 'missing_credentials' }) }
        },
    })
    assert.equal(result.ready, false)
    assert.equal(result.expected, false)
    assert.equal(calls, 0, 'no health polling for the lane that is expected to stay not-ready')
    assert.equal(now(), 0, 'no time is spent waiting')
})
