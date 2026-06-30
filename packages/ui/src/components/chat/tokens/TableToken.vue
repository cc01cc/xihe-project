<script setup lang="ts">
import type { Tokens } from 'marked'
import MarkdownTokens from './MarkdownTokens.vue'

defineProps<{
  token: Tokens.Table
}>()

function alignClass(align: Tokens.TableCell['align']): string {
  if (align === 'center') return 'text-center'
  if (align === 'right') return 'text-right'
  return 'text-left'
}
</script>

<template>
  <div class="overflow-x-auto my-2">
    <table class="min-w-full border-collapse border text-sm">
      <thead>
        <tr>
          <th
            v-for="(cell, index) in token.header"
            :key="index"
            class="border px-3 py-2 font-medium bg-muted"
            :class="alignClass(cell.align)"
          >
            <MarkdownTokens :tokens="cell.tokens" />
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, rowIndex) in token.rows" :key="rowIndex">
          <td
            v-for="(cell, cellIndex) in row"
            :key="cellIndex"
            class="border px-3 py-2"
            :class="alignClass(cell.align)"
          >
            <MarkdownTokens :tokens="cell.tokens" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
