<script setup lang="ts">
import { AlertDialogAction, type AlertDialogActionProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { buttonVariants, type ButtonVariants } from '@/components/ui/button'
import { reactiveOmit } from "@vueuse/core"
import { cn } from "@/lib/utils"

const props = withDefaults(
  defineProps<AlertDialogActionProps & {
    class?: HTMLAttributes["class"]
    variant?: ButtonVariants["variant"]
    size?: ButtonVariants["size"]
  }>(),
  {
    variant: "default",
    size: "default",
  },
)

const delegatedProps = reactiveOmit(props, "class", "variant", "size")
</script>

<template>
  <AlertDialogAction
    data-slot="alert-dialog-action"
    v-bind="delegatedProps"
    :class="cn('', buttonVariants({ variant, size }), props.class)"
  >
    <slot />
  </AlertDialogAction>
</template>
