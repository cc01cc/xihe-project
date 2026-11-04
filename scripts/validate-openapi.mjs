import fs from 'node:fs'

const file = new URL('../docs/api/openapi.yaml', import.meta.url)
const text = fs.readFileSync(file, 'utf8')
if (!/^openapi:\s*3\.1\.0\s*$/m.test(text)) throw new Error('OpenAPI 3.1 header missing')
const paths = [...text.matchAll(/^  (\/[^:]+):\s*$/gm)].map((match) => match[1])
const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index)
if (duplicates.length) throw new Error(`Duplicate paths: ${[...new Set(duplicates)].join(', ')}`)
for (const path of paths) {
  if (path.includes('{')) {
    const parameters = text.slice(text.indexOf(`  ${path}:`), text.indexOf('\n  /', text.indexOf(`  ${path}:`) + 4))
    for (const name of path.matchAll(/\{([^}]+)\}/g)) {
      if (!parameters.includes(`name: ${name[1]}`)) throw new Error(`Missing path parameter ${name[1]} for ${path}`)
    }
  }
}
if (!text.includes('application/problem+json') || !text.includes('ProblemDetails')) {
  throw new Error('Problem Details schema is not declared')
}

// PLAN-0641 M3: the checkpoint-revert risk grading is a cross-layer contract — the three wire
// fields and the two 409 gate codes must stay declared on the document, not only in prose.
// Scoped slices keep the assertions honest: a name that appears elsewhere cannot satisfy them.
function sliceBetween(startMarker, endMarker) {
  const start = text.indexOf(startMarker)
  if (start < 0) throw new Error(`Missing contract block: ${startMarker.trim()}`)
  const end = text.indexOf(endMarker, start + startMarker.length)
  return end < 0 ? text.slice(start) : text.slice(start, end)
}

const revertRequest = sliceBetween('\n    CheckpointRevertRequest:', '\n    CheckpointRevertPreviewEntry:')
for (const field of ['force:', 'acknowledgeNestedRepos:']) {
  if (!revertRequest.includes(field)) throw new Error(`CheckpointRevertRequest must declare ${field}`)
}
for (const schema of ['CheckpointRevertPreviewResponse', 'CheckpointRevertResponse']) {
  const block = sliceBetween(`\n    ${schema}:`, '\n    Checkpoint')
  if (!block.includes('nestedRepoAffected:')) throw new Error(`${schema} must declare nestedRepoAffected`)
}
const affected = sliceBetween('\n    CheckpointNestedRepoAffected:', '\n    Checkpoint')
for (const field of ['repoPath:', 'kind:', 'dirty:', 'headMoved:']) {
  if (!affected.includes(field)) throw new Error(`CheckpointNestedRepoAffected must declare ${field}`)
}
const publicExecute = sliceBetween('\n  /api/v1/workspaces/{workspaceId}/checkpoints/revert:', '\n  /')
const runtimeExecute = sliceBetween(
  '\n  /internal/v1/runtime/workspaces/{workspaceId}/checkpoints/revert:',
  '\n  /',
)
// PLAN-0641 M4: the legacy-slice boundary is decided CP-side, so only the public operation
// names CROSS_ROOT_LEGACY_SLICE and the legacyRoots body; the Runtime pair keeps the M3 codes.
for (const code of ['NESTED_REPO_DIRTY', 'NESTED_REPO_UNCONFIRMED', 'CROSS_ROOT_LEGACY_SLICE']) {
  if (!publicExecute.includes(code)) throw new Error(`public checkpoint revert must name ${code}`)
}
if (!publicExecute.includes('legacyRoots')) {
  throw new Error('public checkpoint revert must document the legacyRoots body')
}
for (const code of ['NESTED_REPO_DIRTY', 'NESTED_REPO_UNCONFIRMED']) {
  if (!runtimeExecute.includes(code)) throw new Error(`runtime checkpoint revert must name ${code}`)
}

// PLAN-0668 M2: the session read projection is a cross-layer contract. Lineage must be declared
// on `Session` (detail view) and required on `SessionSummary` (list view, already declared by
// BL-270); `archived` stays required on `Session`. Assertions are schema-scoped so a same-named
// field elsewhere in the document cannot satisfy them.
const sessionBlock = sliceBetween('\n    Session: {', '\n    SessionForkResponse:')
for (const field of ['kind:', 'spawnedFromSessionId:', 'spawnedFromRunId:', 'spawnedAt:']) {
  if (!sessionBlock.includes(field)) throw new Error(`Session must declare lineage field ${field}`)
}
if (!/required: \[[^\]]*\barchived\b/.test(sessionBlock)) {
  throw new Error('Session.required must include archived')
}
const sessionSummaryBlock = sliceBetween('\n    SessionSummary:', '\n    Session: {')
for (const field of ['kind', 'spawnedFromSessionId', 'spawnedAt']) {
  if (!new RegExp(`required: \\[[^\\]]*\\b${field}\\b`).test(sessionSummaryBlock)) {
    throw new Error(`SessionSummary.required must include ${field}`)
  }
}
console.log(`OpenAPI structural validation passed (${paths.length} paths)`)
