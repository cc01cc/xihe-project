#!/usr/bin/env node
/**
 * Scan log-like files for plaintext secrets (PLAN-196 M4 gate for PLAN-195 M6).
 *
 * task-174 (2026-11-17) — scan face narrowed to git-TRACKED files:
 * the gate used to scan logs/ unconditionally, which made it fire on gitignored
 * runtime logs (HIT bare-secret-field logs/cp.out.log:125 on 2026-11-17) and
 * kept \`mise run lint\` permanently red — a standing false signal that drowns
 * real ones (D-1005 family: the gate was scanning objects it does not own).
 * Boundary: runtime logs are NOT the secrets surface. If a secret is printed
 * into a runtime log, that is a defect of the PRINTER (redaction discipline,
 * DEV-004 / RedactingWriter), never something a log-file scanner should patch.
 * The remaining face is repo hygiene: a plaintext secret in a TRACKED
 * .log/.jsonl/.txt file must still be caught (reverse control, --selftest).
 *
 * Usage:
 *   node scripts/scan-log-secrets.mjs [path ...]   # default root: logs/
 *   node scripts/scan-log-secrets.mjs --selftest   # built-in fixtures (6 cases)
 *
 * Exit codes:
 *   0  clean (all scanned files are tracked and pattern-free; untracked files
 *      are skipped and the skip count is printed)
 *   1  hit found in a tracked file, unreadable file (fail-closed), or selftest
 *      failure
 *   2  cannot answer: git is unavailable or the cwd is not inside a git
 *      repository — a gate that cannot run must never look green
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SECRET_FIELD = String.raw`(?:access[_-]?token|refresh[_-]?token|api[_-]?key|service[_-]?token|client[_-]?secret|token|secret|password|authorization|cookie|pkce|verifier)`

const PATTERNS = [
  { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  // XH Channel (PLAN-245): envelope payloads must never carry secrets; catch
  // Authorization/pwd-style keys inside channel/LogRecord JSON fields.
  {
    name: 'quoted-secret-field',
    re: new RegExp(
      String.raw`['"]?${SECRET_FIELD}['"]?\s*(?::|=)\s*['"](?!\*\*\*redacted\*\*\*)[^'"\r\n]{4,}['"]`,
      'gi',
    ),
  },
  {
    name: 'bare-secret-field',
    re: new RegExp(
      String.raw`\b${SECRET_FIELD}\b\s*(?::|=)\s*(?!\*\*\*redacted\*\*\*)(?!['"])(?!${SECRET_FIELD}\b)[^\s,;}\]]{4,}`,
      'gi',
    ),
  },
]

const LOG_FILE_RE = /\.(log|jsonl|txt)$/

function collectFiles(path, out) {
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    throw new Error(`cannot inspect ${path}`, { cause: error })
  }
  if (stat.isDirectory()) {
    let entries
    try {
      entries = readdirSync(path)
    } catch (error) {
      throw new Error(`cannot read directory ${path}`, { cause: error })
    }
    for (const entry of entries) {
      collectFiles(join(path, entry), out)
    }
    return
  }
  if (LOG_FILE_RE.test(path)) out.push(path)
}

/** Files under roots that git tracks; null = git could not answer (exit 2). */
function trackedFilesUnder(roots, cwd) {
  const result = spawnSync('git', ['ls-files', '-z', '--', ...roots], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) return null
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => resolve(cwd, entry))
}

function scan(roots, cwd = process.cwd()) {
  const tracked = trackedFilesUnder(roots, cwd)
  if (tracked === null) {
    console.error(
      'scan-log-secrets: cannot answer (git ls-files failed or cwd is not a git repository); a gate that cannot run must not look green',
    )
    process.exit(2)
  }
  const trackedSet = new Set(tracked)
  const files = []
  try {
    for (const root of roots) collectFiles(resolve(cwd, root), files)
  } catch (error) {
    console.error(`scan-log-secrets: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const kept = files.filter((file) => trackedSet.has(file))
  const skipped = files.length - kept.length
  let hits = 0
  for (const file of kept) {
    let content
    try {
      content = readFileSync(file, 'utf8')
    } catch (error) {
      hits += 1
      console.error(
        `ERROR unreadable ${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    const lines = content.split('\n')
    lines.forEach((line, index) => {
      for (const { name, re } of PATTERNS) {
        re.lastIndex = 0
        if (re.test(line)) {
          hits += 1
          console.error(`HIT ${name} ${file}:${index + 1}`)
        }
      }
    })
  }
  if (skipped > 0) {
    console.log(
      `scan-log-secrets: skipped ${skipped} untracked file(s) — runtime logs are not the secrets surface (printer discipline, DEV-004)`,
    )
  }
  if (hits > 0) {
    console.error(`scan-log-secrets: ${hits} potential secret(s) found in ${kept.length} tracked file(s)`)
    process.exit(1)
  }
  console.log(`scan-log-secrets: clean (${kept.length} tracked file(s) scanned)`)
}

const SECRET_LINE = 'service_token: super-secret-value-12345'

/** Built-in fixtures (task-174): the reverse control lives here, not in e2e. */
function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'scan-log-secrets-selftest-'))
  const repo = join(root, 'repo')
  const cases = []
  const check = (name, ok, detail = '') => {
    cases.push({ name, ok, detail })
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  }
  try {
    const git = (args, opts = {}) => {
      const result = spawnSync('git', args, { cwd: repo, windowsHide: true, ...opts })
      if (result.error || result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString().slice(0, 200)}`)
      }
    }
    spawnSync('git', ['init', '-q', repo], { windowsHide: true })
    const logs = join(repo, 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'tracked-secret.log'), `line1\n${SECRET_LINE}\n`)
    writeFileSync(join(logs, 'untracked-secret.log'), SECRET_LINE + '\n')
    writeFileSync(join(logs, 'tracked-clean.log'), `password: ***redacted***\nok line\n`)
    git(['add', 'logs/tracked-secret.log', 'logs/tracked-clean.log'])
    git(['-c', 'user.email=selftest@local', '-c', 'user.name=selftest', 'commit', '-qm', 'fixture'])

    const script = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    const runScan = (args, env) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: repo,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ...env },
      })

    const hitRun = runScan([])
    check(
      'tracked secret file is caught (exit 1, HIT bare-secret-field)',
      hitRun.status === 1 && /HIT bare-secret-field .*tracked-secret\.log:2/.test(hitRun.stderr),
      (hitRun.stderr || '').split('\n').find((l) => l.startsWith('HIT')) ?? '',
    )
    check(
      'untracked sibling is skipped, never reported',
      hitRun.status === 1 && !/untracked-secret/.test(hitRun.stderr) && /skipped 1 untracked/.test(hitRun.stdout),
      (hitRun.stdout || '').trim().split('\n')[0] ?? '',
    )
    const cleanRun = runScan(['logs/tracked-clean.log'])
    check(
      'tracked clean file scans exit 0 with redaction honoured',
      cleanRun.status === 0 && /clean \(1 tracked file/.test(cleanRun.stdout),
      (cleanRun.stdout || '').trim(),
    )
    const brokenRun = runScan([], { GIT_DIR: 'Q:/definitely-not-a-repo' })
    check(
      'git cannot answer ⇒ exit 2, never green',
      brokenRun.status === 2 && /cannot answer/.test(brokenRun.stderr),
      `exit=${brokenRun.status}`,
    )
    check(
      'redacted value does not match (pattern negative on tracked file)',
      cleanRun.status === 0 && !/HIT/.test(cleanRun.stderr),
      '',
    )
    check(
      'skip note names the boundary (runtime logs ≠ secrets surface)',
      /printer discipline/.test(hitRun.stdout),
      '',
    )
  } catch (error) {
    check('selftest harness itself ran', false, String(error).slice(0, 200))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  const failed = cases.filter((c) => !c.ok)
  console.log(`scan-log-secrets selftest: ${cases.length - failed.length}/${cases.length} passed`)
  if (failed.length > 0) process.exit(1)
}

const args = process.argv.slice(2)
if (args.includes('--selftest')) {
  selftest()
} else {
  const roots = args.length > 0 ? args : ['logs']
  scan(roots)
}
