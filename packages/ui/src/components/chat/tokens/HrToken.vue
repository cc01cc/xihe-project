<script setup lang="ts">
import type { Tokens } from 'marked'

defineProps<{
  token: Tokens.Hr
}>()
</script>

<template>
  <hr class="my-3 border-border" >
</template>
