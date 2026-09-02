#!/usr/bin/env node
/**
 * Scan log files for plaintext secrets (PLAN-196 M4 gate for PLAN-195 M6).
 *
 * Usage: node scripts/scan-log-secrets.mjs [path ...]
 * Defaults to scanning logs/ under the repo root. Exit 1 on any hit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SECRET_FIELD = String.raw`(?:access[_-]?token|refresh[_-]?token|api[_-]?key|service[_-]?token|client[_-]?secret|token|secret|password|authorization|cookie|pkce|verifier)`

const PATTERNS = [
  { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
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

const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['logs']
const files = []
try {
  for (const root of roots) collectFiles(resolve(root), files)
} catch (error) {
  console.error(`scan-log-secrets: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

let hits = 0
for (const file of files) {
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    hits += 1
    console.error(`ERROR unreadable ${file}: ${error instanceof Error ? error.message : String(error)}`)
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

if (hits > 0) {
  console.error(`scan-log-secrets: ${hits} potential secret(s) found in ${files.length} file(s)`)
  process.exit(1)
}
console.log(`scan-log-secrets: clean (${files.length} file(s) scanned)`)
