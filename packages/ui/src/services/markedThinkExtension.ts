import type { MarkedExtension, TokenizerExtension } from 'marked'

const THINK_REGEX = /^<think>[\s\S]*?<\/think>/
const THINK_START_REGEX = /^<think>([\s\S]*)$/

export interface ThinkToken {
  type: 'think'
  raw: string
  text: string
  complete: boolean
}

export function thinkExtension(): MarkedExtension {
  const think: TokenizerExtension = {
    name: 'think',
    level: 'block',
    start(src: string) {
      return src.indexOf('<think>')
    },
    tokenizer(src: string) {
      const completeMatch = THINK_REGEX.exec(src)
      if (completeMatch) {
        const raw = completeMatch[0]
        const text = raw.slice(7, -8)
        return {
          type: 'think',
          raw,
          text,
          complete: true,
        } as ThinkToken as unknown as ReturnType<TokenizerExtension['tokenizer']>
      }

      const startMatch = THINK_START_REGEX.exec(src)
      if (startMatch) {
        const raw = startMatch[0]
        return {
          type: 'think',
          raw,
          text: startMatch[1] ?? '',
          complete: false,
        } as ThinkToken as unknown as ReturnType<TokenizerExtension['tokenizer']>
      }

      return undefined
    },
  }

  return { extensions: [think] }
}
