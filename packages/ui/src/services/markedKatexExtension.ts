import type { MarkedExtension, TokenizerExtension } from 'marked'

const BLOCK_MATH_REGEX = /^\$\$[\s\S]*?\$\$/
const INLINE_MATH_REGEX = /^\$(?:[^$\n]|\\\$)+\$/

export interface InlineKatexToken {
  type: 'inlineKatex'
  raw: string
  text: string
}

export interface BlockKatexToken {
  type: 'blockKatex'
  raw: string
  text: string
}

export function katexExtension(): MarkedExtension {
  const blockKatex: TokenizerExtension = {
    name: 'blockKatex',
    level: 'block',
    start(src: string) {
      return src.match(/^\$\$/)?.index
    },
    tokenizer(src: string) {
      const match = BLOCK_MATH_REGEX.exec(src)
      if (!match) return undefined
      const raw = match[0]
      const text = raw.slice(2, -2).trim()
      return {
        type: 'blockKatex',
        raw,
        text,
      } as BlockKatexToken as unknown as ReturnType<TokenizerExtension['tokenizer']>
    },
  }

  const inlineKatex: TokenizerExtension = {
    name: 'inlineKatex',
    level: 'inline',
    start(src: string) {
      return src.indexOf('$')
    },
    tokenizer(src: string) {
      const match = INLINE_MATH_REGEX.exec(src)
      if (!match) return undefined
      const raw = match[0]
      const text = raw.slice(1, -1).replace(/\\\$/g, '$')
      return {
        type: 'inlineKatex',
        raw,
        text,
      } as InlineKatexToken as unknown as ReturnType<TokenizerExtension['tokenizer']>
    },
  }

  return { extensions: [blockKatex, inlineKatex] }
}
