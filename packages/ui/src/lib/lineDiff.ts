export interface LineDiffRow {
  type: 'context' | 'add' | 'remove'
  text: string
}

export interface LineDiffResult {
  rows: LineDiffRow[]
  /** True when one side exceeded `maxLines` and was cut for the small diff view. */
  truncated: boolean
}

/**
 * Small line-based diff for the rollback "查看差异" view (PLAN-0328 M3). LCS alignment over
 * capped inputs: the checkpoint blob endpoint allows up to 1 MiB, which is too much for an
 * inline diff, so both sides are cut at `maxLines` and the caller surfaces `truncated`.
 */
export function computeLineDiff(oldText: string, newText: string, maxLines = 400): LineDiffResult {
  const oldLinesAll = oldText.split('\n')
  const newLinesAll = newText.split('\n')
  const truncated = oldLinesAll.length > maxLines || newLinesAll.length > maxLines
  const oldLines = oldLinesAll.slice(0, maxLines)
  const newLines = newLinesAll.slice(0, maxLines)
  const n = oldLines.length
  const m = newLines.length

  const lcs: Uint32Array[] = []
  for (let i = 0; i <= n; i += 1) lcs.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = oldLines[i] === newLines[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const rows: LineDiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: 'context', text: oldLines[i] })
      i += 1
      j += 1
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: 'remove', text: oldLines[i] })
      i += 1
    } else {
      rows.push({ type: 'add', text: newLines[j] })
      j += 1
    }
  }
  while (i < n) {
    rows.push({ type: 'remove', text: oldLines[i] })
    i += 1
  }
  while (j < m) {
    rows.push({ type: 'add', text: newLines[j] })
    j += 1
  }
  return { rows, truncated }
}
