// PLAN-0525 decision #9: bounded acceptance test for the Agent readiness gate.
// Deterministic and side-effect free — the health endpoint, clock and sleep are
// injected, so nothing binds a port and no stack starts.
//
//   node --test scripts/e2e-host-readiness.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { waitForAgentLlmReady } from './lib/agent-readiness.mjs'
import { describeStamp, stampCpArtifact } from './lib/cp-artifact-stamp.mjs'
import { evaluateSidecar, parseSidecar, sidecarPathFor } from './lib/cp-jar-sidecar.mjs'
import { evaluatePgInstanceFreshness, PG_FRESHNESS_REASONS } from './lib/pg-readiness.mjs'
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

const STAMP_TREE_TEXT = '100644 blob aaaa\tpackages/control-plane/pom.xml\n'
const STAMP_COMMIT = 'b'.repeat(40)
const JAR_BYTES = Buffer.from('task-180: bytes are bytes\n', 'utf8')

/** The four git answers stampCpArtifact needs (HEAD, CP-scoped dirty, source tree listing). */
function fakeStampGit({ headFails = false } = {}) {
    return (cmd, args) => {
        if (cmd !== 'git') return { status: 1, stdout: '', stderr: 'unexpected command' }
        if (args[0] === 'rev-parse') {
            return headFails
                ? { status: 128, stdout: '', stderr: 'fatal: HEAD unknown' }
                : { status: 0, stdout: `${STAMP_COMMIT}\n`, stderr: '' }
        }
        if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' }
        if (args[0] === 'ls-tree') return { status: 0, stdout: Buffer.from(STAMP_TREE_TEXT, 'utf8'), stderr: '' }
        return { status: 1, stdout: '', stderr: `unexpected git ${args[0]}` }
    }
}

test('task-180: the rebuild branch writes the fresh jar\'s two marks through ONE call', () => {
    // The stamp (in-jar build-info) and the fingerprint (sidecar) may only be written by the path that
    // produced the jar, and only *after* packaging finished — otherwise `builtAt` predates the artifact
    // it describes (the exact failure mode of the in-jar stamp). Both used to be hand-written here and
    // in the preflight self-heal branch; the self-heal copy refreshed only the stamp, so every run
    // compared a NEW jar against an OLD sidecar (task-141 run1: exit 1, Playwright never started).
    const source = readFileSync(new URL('./e2e-host.mjs', import.meta.url), 'utf8')
    // task-42 moved this read behind the shared sampler: the re-inspection after `mvn package` is a
    // **refresh point**, so the anchor is the sampler call that produces it.
    const start = source.indexOf("const { state: after } = recordJarSample({ sampledBy: 'after-rebuild', publish: false })")
    const end = source.indexOf("return { mode: 'jar', jar: after.jar, reason: 'rebuilt' }")
    assert.ok(start >= 0 && end > start, 'rebuild branch anchors must exist')
    const branch = source.slice(start, end)
    assert.match(branch, /const stamp = stampCpArtifact\(\{/u)
    assert.match(branch, /jarPath: after\.jar\.path/u)
    // A second call site is how the pair drifted: neither writer may be called directly any more.
    assert.doesNotMatch(source, /writeBuildInfo\(/u)
    assert.doesNotMatch(source, /writeSidecarForJar\(/u)
})

test('task-180: the preflight self-heal branch shares that one call, so a rebuilt jar is never half stamped', () => {
    const source = readFileSync(new URL('./e2e-host.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('preflight 前自愈：CP jar')
    const end = source.indexOf('[e2e-host] preflight (read-only)')
    assert.ok(start >= 0 && end > start, 'self-heal branch anchors must exist')
    const region = source.slice(start, end)
    assert.match(region, /stampCpArtifact\(\{/u, 'the self-heal branch must stamp through the shared lib')
    assert.match(region, /jarPath: healed\.jar\.path/u)
    const callSites = source.match(/stampCpArtifact\(\{/gu) ?? []
    assert.equal(callSites.length, 2, 'exactly two producers: the rebuild branch and the preflight self-heal')
})

test('task-42 J3: the boot plan and the window gate consume ONE published sample (same source, same id)', () => {
    // The defect was two independent reads: the boot plan judged one sample, `e2e-preflight.mjs` read the
    // same artifact again, and the self-heal branch could only fire when they disagreed (a read gap).
    // These are the structural half of the fix — the behavioural half is `cp-jar-snapshot.test.mjs`,
    // which proves the record round-trips into the same reader input.
    const host = readFileSync(new URL('./e2e-host.mjs', import.meta.url), 'utf8')
    // ① one sampler: every refresh point goes through `recordJarSample`, and the gate reuses `jarSnapshot`
    // instead of calling the raw reader again.
    const gate = host.slice(host.indexOf('async function runPreflightGate('), host.indexOf('async function runSkipPreflightDiskGate('))
    assert.ok(gate.length > 0, 'gate anchors must exist')
    assert.match(gate, /const snapshot = jarSnapshot \?\? recordJarSample\(/u, 'the gate must reuse the boot plan sample')
    assert.doesNotMatch(gate, /[^a-zA-Z]resolveCpJarState\(/u, 'the gate must not open a second read of the artifact')
    // ② an observable id, printed where the sample is taken and handed to the child by path.
    assert.match(gate, /--jar-snapshot=\$\{jarSnapshotFile\}/u, 'the sample must be handed to the preflight by path')
    assert.match(host, /describeSnapshotSource\(\{/u)
    // ③ the preflight verifies the handoff and judges **its** bytes.
    const preflight = readFileSync(new URL('./e2e-preflight.mjs', import.meta.url), 'utf8')
    assert.match(preflight, /loadJarSnapshot\(\{ file: jarSnapshotFile \|\| null, targetDir: cpTarget \}\)/u)
    assert.match(preflight, /evaluateSidecar\(\{ jarPath: cpJar\.path, projectDir, sample: sharedSample \}\)/u,
        'the artifact section must feed the shared sample to the same reader state machine')
    assert.match(preflight, /source=own-read/u, 'a standalone run must say it sampled for itself')
    assert.match(preflight, /shared jar sample REFUSED/u, 'a bad handoff must be loud, not a silent re-read')
})

test('task-180: the stamp lands before the fingerprint, and the pair describes this jar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xihe-artifact-stamp-'))
    try {
        const targetDir = join(dir, 'target')
        const jarPath = join(dir, 'control-plane-0.1.0.jar')
        writeFileSync(jarPath, JAR_BYTES)
        // The sidecar builder cannot be forged onto an older artifact (write-lag guard), so pin its
        // clock to the jar's own mtime instead of depending on how fast this test writes it.
        const jarMtimeMs = statSync(jarPath).mtimeMs
        const buildInfoSeenAtFingerprint = []
        const stamp = stampCpArtifact({
            projectDir: dir,
            targetDir,
            jarPath,
            writtenBy: 'scripts/e2e-host.mjs',
            run: fakeStampGit(),
            now: () => jarMtimeMs,
            stat: (file) => {
                buildInfoSeenAtFingerprint.push(existsSync(buildInfoPath(targetDir)))
                return statSync(file)
            },
        })
        assert.equal(stamp.paired, true)
        assert.equal(stamp.buildInfo.ok, true)
        assert.equal(stamp.buildInfo.commit, STAMP_COMMIT)
        assert.equal(stamp.sidecar.ok, true)
        // THE ordering assertion: when the fingerprint is computed, the stamp already exists.
        assert.deepEqual(buildInfoSeenAtFingerprint, [true])
        const written = parseSidecar(readFileSync(sidecarPathFor(jarPath), 'utf8'))
        assert.equal(written.ok, true)
        assert.equal(written.data.commit, STAMP_COMMIT)
        assert.equal(written.data.writtenBy, 'scripts/e2e-host.mjs')
        const lines = describeStamp({ ...stamp, label: 'rebuild' }).join('\n')
        assert.match(lines, /\[e2e-host\] rebuild: CP build-info stamped for b{12} \(dirty=false\)/u)
        assert.match(lines, /\[e2e-host\] rebuild: CP jar sidecar written: .+control-plane-0\.1\.0\.jar\.buildinfo\.json/u)
        assert.doesNotMatch(lines, /WARN/u)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('task-180 J2: a jar that is not the artifact its sidecar describes is still identity-mismatch', () => {
    // The negative control for the whole card: sharing the write path must not weaken the READER. A
    // jar replaced behind a valid manifest stays the non-deferrable identity failure — if this ever
    // goes green, the fix "paired the writes" by loosening the judgement instead.
    const dir = mkdtempSync(join(tmpdir(), 'xihe-artifact-stamp-neg-'))
    try {
        const targetDir = join(dir, 'target')
        const jarPath = join(dir, 'control-plane-0.1.0.jar')
        writeFileSync(jarPath, JAR_BYTES)
        const jarMtimeMs = statSync(jarPath).mtimeMs
        const stamp = stampCpArtifact({
            projectDir: dir,
            targetDir,
            jarPath,
            writtenBy: 'scripts/e2e-host.mjs',
            run: fakeStampGit(),
            now: () => jarMtimeMs,
        })
        assert.equal(stamp.paired, true, 'precondition: the pair was written first')
        writeFileSync(jarPath, Buffer.from('a different jar, same file name\n', 'utf8'))
        const verdict = evaluateSidecar({ jarPath, projectDir: dir, run: fakeStampGit() })
        assert.equal(verdict.state, 'identity-mismatch')
        assert.ok(verdict.actualJarSha256 !== verdict.expectedJarSha256)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
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

// task-117 (DSD-1501): the PG readiness gate must judge freshness by container identity.
// These cases pin the judgement that replaced the wall-clock 2 s tolerance: on this host the
// Windows clock runs ~+5 s ahead of the Docker VM clock, so `StartedAt >= upMicros - 2 s`
// rejected a healthy, freshly created container on every run (task-27: two runs, exit 1,
// zero tests executed).

test('host clock running 10 s ahead still counts as fresh once the container id changed', () => {
    // Expressed the way the runner sees it: the new container's StartedAt looks *older* than
    // the moment `up` began (VM clock behind the host), but --force-recreate replaced the
    // container, so the identity is new. Clock data must not enter the judgement at all.
    const result = evaluatePgInstanceFreshness({
        id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
        priorId: '0f0e0d0c0b0a09080706050403020100ffeeddccbbaa99887766554433221100',
        startedAt: '2026-11-20T12:11:41.459675896Z',
        upBeganAtMs: Date.parse('2026-11-20T12:11:51.459Z'),
    })
    assert.equal(result.fresh, true)
    assert.equal(result.reason, PG_FRESHNESS_REASONS.INSTANCE_REPLACED)
})

test('an unchanged container id is stale even when status/health look ready', () => {
    const same = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'
    const result = evaluatePgInstanceFreshness({ id: same, priorId: same })
    assert.equal(result.fresh, false)
    assert.equal(result.reason, PG_FRESHNESS_REASONS.SAME_INSTANCE)
})

test('a cold start with no pre-existing container is fresh', () => {
    for (const priorId of ['', '   ', undefined, null]) {
        const result = evaluatePgInstanceFreshness({ id: 'a1b2c3d4', priorId })
        assert.equal(result.fresh, true, `priorId=${JSON.stringify(priorId)} must be treated as absent`)
        assert.equal(result.reason, PG_FRESHNESS_REASONS.NO_PRIOR_CONTAINER)
    }
})

test('an unknown current id is fail-closed (never fresh)', () => {
    for (const id of ['', '   ', undefined, null, 42]) {
        const result = evaluatePgInstanceFreshness({ id, priorId: 'deadbeef' })
        assert.equal(result.fresh, false, `id=${JSON.stringify(id)} must not be judged fresh`)
        assert.equal(result.reason, PG_FRESHNESS_REASONS.ID_MISSING)
    }
})

test('e2e-host wires the pure judgement and no longer compares StartedAt against the host clock', () => {
    const source = readFileSync(new URL('./e2e-host.mjs', import.meta.url), 'utf8')
    assert.match(source, /import \{ evaluatePgInstanceFreshness \} from '\.\/lib\/pg-readiness\.mjs'/u)
    // The removed defect: any wall-clock tolerance expressed as a Date.now() baseline.
    assert.doesNotMatch(source, /startedAtMs/u)
    assert.doesNotMatch(source, /startedAtDate >= startedAtMs - 2_000/u)
    // prior id must be read BEFORE `up`, otherwise --force-recreate would hand back the new id
    // and the comparison could never detect a stale container.
    const priorReadIdx = source.indexOf('const priorContainerId = await readPgContainerId()')
    const upIdx = source.indexOf("dockerCompose(['up', '-d', '--no-deps', '--wait', '--force-recreate', 'postgres']")
    assert.ok(priorReadIdx > 0, 'startIsolatedPostgres must read the prior container id')
    assert.ok(upIdx > priorReadIdx, 'the prior id must be read before compose up')
    assert.match(source, /waitForPostgresContainerHealthy\(priorContainerId\)/u)
    assert.match(source, /async function readPgContainerId\(\)/u)
})
