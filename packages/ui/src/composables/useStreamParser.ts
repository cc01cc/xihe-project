import { ref } from 'vue'
import type { MessagePart } from '../types'

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'
const ARTIFACT_OPEN_REGEX = /^<artifact\b([^>]*)>/
const ARTIFACT_CLOSE = '</artifact>'
const CITATION_REGEX = /\[(\d+)]/g

function parseArtifactAttrs(attrs: string): { identifier: string; artifactType: string; title: string } {
  const idMatch = attrs.match(/identifier=["']([^"']+)["']/)
  const typeMatch = attrs.match(/type=["']([^"']+)["']/)
  const titleMatch = attrs.match(/title=["']([^"']+)["']/)
  return {
    identifier: idMatch?.[1] ?? '',
    artifactType: typeMatch?.[1] ?? '',
    title: titleMatch?.[1] ?? '',
  }
}

/**
 * Parse a raw content string into structured MessagePart[].
 * Detects <think>...</think>, <artifact ...>...</artifact>, [N] citations.
 * Handles unclosed tags at end of input.
 */
export function parseRawToParts(raw: string): MessagePart[] {
  const output: MessagePart[] = []
  let remaining = raw
  let textAccum = ''

  function flushText() {
    if (!textAccum) return
    const parts: MessagePart[] = []
    let lastIndex = 0
    let m: RegExpExecArray | null
    const re = CITATION_REGEX
    re.lastIndex = 0
    while ((m = re.exec(textAccum)) !== null) {
      if (m.index > lastIndex) {
        parts.push({ type: 'text', content: textAccum.slice(lastIndex, m.index) })
      }
      parts.push({ type: 'citation', index: Number.parseInt(m[1], 10) })
      lastIndex = re.lastIndex
    }
    if (lastIndex < textAccum.length) {
      parts.push({ type: 'text', content: textAccum.slice(lastIndex) })
    }
    output.push(...parts)
    textAccum = ''
  }

  while (remaining.length > 0) {
    const thinkIdx = remaining.indexOf(THINK_OPEN)
    const artifactIdx = remaining.indexOf('<artifact')
    const closeThinkIdx = remaining.indexOf(THINK_CLOSE)
    const closeArtifactIdx = remaining.indexOf(ARTIFACT_CLOSE)

    // Determine what comes first
    const upcoming: Array<{ idx: number; kind: 'think-open' | 'artifact-open' | 'think-close' | 'artifact-close' }> = []

    if (thinkIdx !== -1) upcoming.push({ idx: thinkIdx, kind: 'think-open' })
    if (artifactIdx !== -1) upcoming.push({ idx: artifactIdx, kind: 'artifact-open' })
    if (closeThinkIdx !== -1) upcoming.push({ idx: closeThinkIdx, kind: 'think-close' })
    if (closeArtifactIdx !== -1) upcoming.push({ idx: closeArtifactIdx, kind: 'artifact-close' })

    if (upcoming.length === 0) {
      textAccum += remaining
      break
    }

    upcoming.sort((a, b) => a.idx - b.idx)
    const first = upcoming[0]

    // Emit text before the first marker
    if (first.idx > 0) {
      textAccum += remaining.slice(0, first.idx)
      remaining = remaining.slice(first.idx)
    }

    switch (first.kind) {
      case 'think-open': {
        flushText()
        const afterOpen = remaining.slice(THINK_OPEN.length)
        const endIdx = afterOpen.indexOf(THINK_CLOSE)
        if (endIdx !== -1) {
          const content = afterOpen.slice(0, endIdx)
          output.push({ type: 'reasoning', content })
          remaining = afterOpen.slice(endIdx + THINK_CLOSE.length)
        } else {
          output.push({ type: 'reasoning', content: afterOpen })
          remaining = ''
        }
        break
      }

      case 'artifact-open': {
        flushText()
        const m = ARTIFACT_OPEN_REGEX.exec(remaining)
        if (m) {
          const attrs = parseArtifactAttrs(m[1])
          const innerStart = m[0].length
          const endIdx = remaining.indexOf(ARTIFACT_CLOSE, innerStart)
          if (endIdx !== -1) {
            const content = remaining.slice(innerStart, endIdx)
            output.push({ type: 'artifact', ...attrs, content })
            remaining = remaining.slice(endIdx + ARTIFACT_CLOSE.length)
          } else {
            output.push({ type: 'artifact', ...attrs, content: remaining.slice(innerStart) })
            remaining = ''
          }
        } else {
          textAccum += remaining[0]
          remaining = remaining.slice(1)
        }
        break
      }

      case 'think-close': {
        // Stray close tag without open — treat as text
        textAccum += THINK_CLOSE
        remaining = remaining.slice(THINK_CLOSE.length)
        break
      }

      case 'artifact-close': {
        textAccum += ARTIFACT_CLOSE
        remaining = remaining.slice(ARTIFACT_CLOSE.length)
        break
      }
    }
  }

  flushText()
  return output
}

export function useStreamParser() {
  const parts = ref<MessagePart[]>([])
  const raw = ref('')

  function handleToken(token: string, hint?: 'reasoning' | 'text') {
    if (hint === 'reasoning') {
      const last = parts.value.length > 0 ? parts.value[parts.value.length - 1] : null
      if (last?.type === 'reasoning') {
        last.content += token
      } else {
        parts.value.push({ type: 'reasoning', content: token })
      }
      return
    }

    if (hint === 'text') {
      const clean = token.replace(/<\/?think>/g, '')
      const last = parts.value.length > 0 ? parts.value[parts.value.length - 1] : null
      if (last?.type === 'text') {
        last.content += clean
      } else {
        parts.value.push({ type: 'text', content: clean })
      }
      return
    }

    raw.value += token
    parts.value = parseRawToParts(raw.value)
  }

  function finalize() {
    if (raw.value) {
      parts.value = parseRawToParts(raw.value)
    }
    raw.value = ''
  }

  function reset() {
    raw.value = ''
    parts.value = []
  }

  return { parts, handleToken, finalize, reset }
}
