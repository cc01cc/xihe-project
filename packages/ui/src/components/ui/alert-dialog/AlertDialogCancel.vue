<script setup lang="ts">
import { AlertDialogCancel, type AlertDialogCancelProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { buttonVariants, type ButtonVariants } from '@/components/ui/button'
import { reactiveOmit } from "@vueuse/core"
import { cn } from "@/lib/utils"

const props = withDefaults(
  defineProps<AlertDialogCancelProps & {
    class?: HTMLAttributes["class"]
    variant?: ButtonVariants["variant"]
    size?: ButtonVariants["size"]
  }>(),
  {
    variant: "outline",
    size: "default",
  },
)

const delegatedProps = reactiveOmit(props, "class", "variant", "size")
</script>

<template>
  <AlertDialogCancel
    data-slot="alert-dialog-cancel"
    v-bind="delegatedProps"
    :class="cn(
      '',
      buttonVariants({ variant, size }),
      props.class,
    )"
  >
    <slot />
  </AlertDialogCancel>
</template>
