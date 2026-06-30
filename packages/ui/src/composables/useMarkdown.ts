import { computed, ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import { createMarkdownParser, type MarkdownToken, type MarkdownTokensList } from '@/services/markdownParser'

export type MarkdownRenderMode = 'streaming' | 'complete'

export interface UseMarkdownOptions {
  throttleMs?: number
}

interface PendingUpdate {
  content: string
  isStreaming: boolean
}

const UNCLOSED_FENCE_REGEX = /(?:\r?\n|^)```\s*(\w*)\s*$/

function appendUnclosedCodePlaceholder(tokens: MarkdownToken[], content: string): MarkdownToken[] {
  const match = UNCLOSED_FENCE_REGEX.exec(content)
  if (!match) return tokens

  const lang = match[1] ?? ''
  const fenceStart = content.lastIndexOf('```')
  const rawCode = content.slice(fenceStart + 3 + (lang ? lang.length + 1 : 0))
  return [
    ...tokens,
    {
      type: 'code',
      raw: match[0],
      lang,
      text: rawCode,
      escaped: false,
      codeBlockStyle: undefined,
    } as MarkdownToken,
  ]
}

export function useMarkdown(
  content: MaybeRefOrGetter<string>,
  isStreaming: MaybeRefOrGetter<boolean>,
  options: UseMarkdownOptions = {},
) {
  const { throttleMs = 50 } = options
  const parser = createMarkdownParser()
  const tokens = ref<MarkdownToken[]>([])
  const mode = computed<MarkdownRenderMode>(() => (toValue(isStreaming) ? 'streaming' : 'complete'))

  let rafId: ReturnType<typeof globalThis.setTimeout> | null = null
  let pending: PendingUpdate | null = null
  let lastUpdateTime = 0

  function parseContent(currentContent: string, currentStreaming: boolean): MarkdownToken[] {
    const tokensList: MarkdownTokensList = currentStreaming
      ? parser.parseStreaming(currentContent)
      : parser.parse(currentContent)

    if (currentStreaming) {
      return appendUnclosedCodePlaceholder([...tokensList], currentContent)
    }

    return [...tokensList]
  }

  function flush() {
    rafId = null
    if (!pending) return
    const { content: currentContent, isStreaming: currentStreaming } = pending
    pending = null
    lastUpdateTime = Date.now()
    tokens.value = parseContent(currentContent, currentStreaming)
  }

  function scheduleUpdate() {
    if (rafId !== null) return
    const elapsed = Date.now() - lastUpdateTime
    const delay = Math.max(0, throttleMs - elapsed)
    rafId = globalThis.setTimeout(() => {
      flush()
    }, delay)
  }

  function update() {
    pending = { content: toValue(content), isStreaming: toValue(isStreaming) }
    if (mode.value === 'complete') {
      if (rafId !== null) {
        clearTimeout(rafId)
        rafId = null
      }
      flush()
    } else {
      scheduleUpdate()
    }
  }

  watch(
    () => [toValue(content), toValue(isStreaming)] as const,
    () => update(),
    { immediate: true },
  )

  return {
    tokens,
    mode,
  }
}
