import type { MarkedExtension, TokenizerExtension } from 'marked'

const CITATION_REGEX = /^\[(\d+)]/

export interface CitationToken {
  type: 'citation'
  raw: string
  index: number
}

export function citationExtension(): MarkedExtension {
  const citation: TokenizerExtension = {
    name: 'citation',
    level: 'inline',
    start(src: string) {
      return src.indexOf('[')
    },
    tokenizer(src: string) {
      const match = CITATION_REGEX.exec(src)
      if (!match) return undefined
      const index = Number.parseInt(match[1], 10)
      if (!Number.isFinite(index)) return undefined
      return {
        type: 'citation',
        raw: match[0],
        index,
      } as CitationToken as unknown as ReturnType<TokenizerExtension['tokenizer']>
    },
  }

  return { extensions: [citation] }
}
