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

test('rebuild stamping writes build-info from the real HEAD; a dirty CP tree is a named verdict, not a red', (t) => {
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
    // BL-524: a lane with uncommitted CP edits used to fail this test because the stamp's
    // commit equals HEAD but the tree is dirty. Dirty is a real, nameable state (BL-325), not a
    // regression: the stamp still belongs to the tested commit. Assert the *relative* fact
    // (stamp commit == HEAD) and let `dirty` be its own verdict.
    const verdict = evaluateCpFreshness({ targetDir, headCommit: head.commit })
    assert.equal(verdict.fileCommit, head.commit)
    assert.equal(verdict.status, head.dirty ? 'dirty' : 'fresh')
    assert.equal(verdict.fresh, !head.dirty)
})

/**
 * BL-524: deterministic `gitHead` double — the freshness gate's dirty bit is scoped by
 * `git status --porcelain -- packages/control-plane`, so tests must simulate that exact call
 * instead of reading the real working tree (which makes the suite fail on any CP lane).
 */
function fakeGitRun({ commit = 'a'.repeat(40), cpStatus = '' } = {}) {
    const calls = []
    const run = (cmd, args) => {
        calls.push([cmd, ...args].join(' '))
        if (args[0] === 'rev-parse') return { status: 0, stdout: `${commit}\n`, stderr: '' }
        if (args[0] === 'status') return { status: 0, stdout: cpStatus, stderr: '' }
        throw new Error(`unexpected git call: ${cmd} ${args.join(' ')}`)
    }
    return { run, calls }
}

test('BL-524: uncommitted CP edits => stamp keeps HEAD commit and gets the named `dirty` verdict', (t) => {
    const targetDir = mkdtempSync(join(tmpdir(), 'xihe-e2e-cp-dirty-'))
    t.after(() => rmSync(targetDir, { recursive: true, force: true }))

    const { run } = fakeGitRun({ cpStatus: ' M packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/ResetAdmin.java\n' })
    const head = gitHead({ cwd: projectRoot, run })
    assert.equal(head.error, null, head.error ?? '')
    assert.equal(head.dirty, true)

    writeBuildInfo({ targetDir, commit: head.commit, dirty: head.dirty })
    const verdict = evaluateCpFreshness({ targetDir, headCommit: head.commit })
    assert.equal(verdict.status, 'dirty', 'a dirty CP tree is `dirty`, never a stale/unverified red')
    assert.equal(verdict.fileCommit, head.commit, 'the stamp still belongs to the tested commit')
})

test('BL-524: clean CP tree => same-commit stamp still passes freshness', (t) => {
    const targetDir = mkdtempSync(join(tmpdir(), 'xihe-e2e-cp-clean-'))
    t.after(() => rmSync(targetDir, { recursive: true, force: true }))

    const { run } = fakeGitRun({ cpStatus: '' })
    const head = gitHead({ cwd: projectRoot, run })
    assert.equal(head.error, null, head.error ?? '')
    assert.equal(head.dirty, false)

    writeBuildInfo({ targetDir, commit: head.commit, dirty: head.dirty })
    const verdict = evaluateCpFreshness({ targetDir, headCommit: head.commit })
    assert.equal(verdict.status, 'fresh')
    assert.equal(verdict.fresh, true)
})

test('BL-524: non-CP changes do not affect the judgement (dirty is scoped to packages/control-plane)', () => {
    const { run, calls } = fakeGitRun({ cpStatus: '' })
    const head = gitHead({ cwd: projectRoot, run })
    assert.equal(head.dirty, false)

    // The scope is the contract: a UI/docs/one edit never enters this `git status` call.
    const statusCall = calls.find((call) => call.includes('status --porcelain'))
    assert.ok(statusCall, 'gitHead must probe working-tree state')
    assert.match(statusCall, / status --porcelain -- packages\/control-plane$/u)
    assert.ok(!calls.some((call) => /status --porcelain -- packages\/(ui|agent|runtime)/u.test(call)))

    const stampDir = mkdtempSync(join(tmpdir(), 'xihe-e2e-noncp-'))
    try {
        writeBuildInfo({ targetDir: stampDir, commit: head.commit, dirty: head.dirty })
        assert.equal(evaluateCpFreshness({ targetDir: stampDir, headCommit: head.commit }).fresh, true)
    } finally {
        rmSync(stampDir, { recursive: true, force: true })
    }
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

test('task-90: the CP jar sidecar is written inside the rebuild branch, after packaging and after the stamp', () => {
    // The fingerprint may only be written by the path that produced the jar, and only *after* the
    // package goal finished — otherwise `builtAt` predates the artifact it describes (the exact
    // failure mode of the in-jar build-info stamp). Pin the ordering structurally.
    const source = readFileSync(new URL('./e2e-host.mjs', import.meta.url), 'utf8')
    const afterIdx = source.indexOf("const after = resolveCpJarState(e2eCpTargetDir)")
    const stampIdx = source.indexOf('writeBuildInfo({ targetDir: e2eCpTargetDir', afterIdx)
    const sidecarIdx = source.indexOf('writeSidecarForJar({ projectDir, jarPath: after.jar.path', afterIdx)
    const returnIdx = source.indexOf("return { mode: 'jar', jar: after.jar, reason: 'rebuilt' }", afterIdx)
    assert.ok(afterIdx >= 0, 'the post-build re-inspection anchor must exist')
    assert.ok(stampIdx > afterIdx, 'build-info must be stamped after re-inspecting the fresh jar')
    assert.ok(sidecarIdx > stampIdx, 'the sidecar must be written after packaging AND after the stamp')
    assert.ok(returnIdx > sidecarIdx, 'the sidecar must be written before the branch returns the jar')
    // A sidecar write failure must stay a WARN (the run still has content evidence), never a silent pass.
    assert.match(source.slice(sidecarIdx, returnIdx), /if \(!sidecarWrite\.ok\)/u)
})

test('Windows preflight queries dev-only stack ports, not only the e2e block', () => {
    // preflight is a CLI (importing it runs the checks), so pin the Windows query wiring:
    // dev ports must be merged into $ranges before Get-NetTCPConnection; filtering only
    // after the JSON round-trip can never surface a dev-only port such as 12633 (BL-413).
    const source = readFileSync(new URL('./e2e-preflight.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('function queryListeners(ranges, dev)')
    const end = source.indexOf('function pidAlive', start)
    assert.ok(start >= 0 && end > start, 'queryListeners anchors must exist')
    const branch = source.slice(start, end)
    assert.match(branch, /const queryRanges = \[\.\.\.ranges, \.\.\.dev\.map\(\(\{ port \}\) => \[port, port\]\)\]/u)
    assert.match(branch, /const rangeLiteral = queryRanges\.map/u)
    assert.doesNotMatch(branch, /const rangeLiteral = ranges\.map/u)
})
