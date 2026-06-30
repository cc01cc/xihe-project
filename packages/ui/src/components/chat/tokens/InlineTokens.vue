<script setup lang="ts">
import { computed } from 'vue'
import type { MarkdownToken } from '@/services/markdownParser'
import type { Tokens } from 'marked'
import KatexToken from './KatexToken.vue'
import CitationToken from './CitationToken.vue'

const props = defineProps<{
  token: MarkdownToken
}>()

const text = computed(() => {
  const t = props.token as Tokens.Text
  return t.text ?? ''
})

const inlineTokens = computed(() => {
  const t = props.token as Tokens.Text
  return (t.tokens ?? []) as MarkdownToken[]
})

function isTextToken(token: MarkdownToken): token is Tokens.Text {
  return token.type === 'text' && !('tokens' in token && Array.isArray(token.tokens))
}
</script>

<template>
  <template v-if="token.type === 'text'">
    <template v-if="inlineTokens.length > 0">
      <InlineTokens
        v-for="(t, i) in inlineTokens"
        :key="i"
        :token="t"
      />
    </template>
    <template v-else>{{ text }}</template>
  </template>

  <strong v-else-if="token.type === 'strong'" class="font-semibold">
    <InlineTokens
      v-for="(t, i) in (token as Tokens.Strong).tokens"
      :key="i"
      :token="t"
    />
  </strong>

  <em v-else-if="token.type === 'em'" class="italic">
    <InlineTokens
      v-for="(t, i) in (token as Tokens.Em).tokens"
      :key="i"
      :token="t"
    />
  </em>

  <code
    v-else-if="token.type === 'codespan'"
    class="px-1.5 py-0.5 rounded bg-muted text-sm font-mono"
  >
    {{ (token as Tokens.Codespan).text }}
  </code>

  <del v-else-if="token.type === 'del'">
    <InlineTokens
      v-for="(t, i) in (token as Tokens.Del).tokens"
      :key="i"
      :token="t"
    />
  </del>

  <a
    v-else-if="token.type === 'link'"
    :href="(token as Tokens.Link).href"
    class="text-primary underline underline-offset-2 hover:opacity-80"
    :target="(token as Tokens.Link).href.startsWith('http') ? '_blank' : undefined"
    :rel="(token as Tokens.Link).href.startsWith('http') ? 'noopener noreferrer' : undefined"
  >
    <InlineTokens
      v-for="(t, i) in (token as Tokens.Link).tokens"
      :key="i"
      :token="t"
    />
  </a>

  <img
    v-else-if="token.type === 'image'"
    :src="(token as Tokens.Image).href"
    :alt="(token as Tokens.Image).text"
    :title="(token as Tokens.Image).title ?? undefined"
    class="max-w-full my-2 rounded"
  >

  <br v-else-if="token.type === 'br'">

  <span v-else-if="token.type === 'escape'">{{ (token as Tokens.Escape).text }}</span>

  <KatexToken v-else-if="token.type === 'inlineKatex' || token.type === 'blockKatex'" :token="token" />

  <CitationToken v-else-if="token.type === 'citation'" :token="token" />

  <span v-else-if="isTextToken(token)">{{ text }}</span>

  <span v-else>{{ (token as { text?: string }).text ?? '' }}</span>
</template>
