// PLAN-0525 decision #9: bounded acceptance test for the Agent readiness gate.
// Deterministic and side-effect free — the health endpoint, clock and sleep are
// injected, so nothing binds a port and no stack starts.
//
//   node --test scripts/e2e-host-readiness.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { waitForAgentLlmReady } from './lib/agent-readiness.mjs'
import {
    buildInfoPath,
    evaluateCpFreshness,
    gitHead,
    readBuildInfo,
    writeBuildInfo,
} from './lib/cp-build-info.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

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

test('rebuild stamping writes build-info from the real HEAD and passes freshness', (t) => {
    const targetDir = mkdtempSync(join(tmpdir(), 'xihe-e2e-rebuild-stamp-'))
    t.after(() => rmSync(targetDir, { recursive: true, force: true }))

    // Mirrors e2e-host.mjs's rebuild branch: after a successful mvn package, stamp with
    // gitHead()'s real commit/dirty values (never a hand-filled commit).
    const head = gitHead({ cwd: projectRoot })
    assert.equal(head.error, null, head.error ?? '')
    assert.match(head.commit, /^[0-9a-f]{40}$/u)
    writeBuildInfo({ targetDir, commit: head.commit, dirty: head.dirty })

    assert.equal(existsSync(buildInfoPath(targetDir)), true)
    const { info } = readBuildInfo(targetDir)
    assert.equal(info.commit, head.commit)
    assert.equal(info.dirty, head.dirty)
    assert.equal(evaluateCpFreshness({ targetDir, headCommit: head.commit }).fresh, true)
})

test('e2e-host rebuild branch stamps the fresh jar with the current HEAD', () => {
    // e2e-host.mjs cannot be imported without booting, so pin the wiring itself: the stamp
    // must live after the fresh-jar check and use gitHead's real values.
    const source = readFileSync(new URL('./e2e-host.mjs', import.meta.url), 'utf8')
    const start = source.indexOf("const after = resolveCpJarState(e2eCpTargetDir)")
    const end = source.indexOf("return { mode: 'jar', jar: after.jar, reason: 'rebuilt' }")
    assert.ok(start >= 0 && end > start, 'rebuild branch anchors must exist')
    const branch = source.slice(start, end)
    assert.match(branch, /const head = gitHead\(\{ cwd: projectDir \}\)/u)
    assert.match(branch, /writeBuildInfo\(\{ targetDir: e2eCpTargetDir, commit: head\.commit, dirty: head\.dirty \}\)/u)
})
