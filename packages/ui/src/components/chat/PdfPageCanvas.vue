<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'

const MAX_CANVAS_POOL = 4
const containerRef = ref<HTMLDivElement | null>(null)
let renderTask: any = null
let canvasPool: HTMLCanvasElement[] = []

function getCanvasFromPool(): HTMLCanvasElement {
  let cvs = canvasPool.find(c => c.parentElement === null)
  if (!cvs && canvasPool.length < MAX_CANVAS_POOL) {
    cvs = document.createElement('canvas')
    canvasPool.push(cvs)
  }
  cvs = canvasPool.find(c => c.parentElement === null) || canvasPool[0]
  if (cvs?.parentElement) cvs.remove()
  return cvs!
}

const props = defineProps<{
  pdfDoc: any
  pageNum: number
  scale: number
}>()

async function renderPage() {
  if (!props.pdfDoc || !containerRef.value) return
  if (renderTask) {
    try { renderTask.cancel() } catch { /* */ }
  }
  const page = await props.pdfDoc.getPage(props.pageNum)
  for (const quality of [0.5, 1.0]) {
    if (renderTask?.isCancelled) break
    const renderScale = props.scale * quality
    const viewport = page.getViewport({ scale: renderScale })
    const canvas = getCanvasFromPool()
    const dpr = window.devicePixelRatio || 1
    canvas.width = viewport.width * dpr
    canvas.height = viewport.height * dpr
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    if (quality === 0.5) {
      renderTask = page.render({ canvasContext: ctx, viewport, background: 'white' })
      await renderTask.promise
      containerRef.value.appendChild(canvas)
    } else {
      renderTask = page.render({ canvasContext: ctx, viewport, background: 'white' })
      await renderTask.promise
    }
  }
}

watch(() => [props.pageNum, props.scale], renderPage, { deep: true })
onMounted(renderPage)
onUnmounted(() => { canvasPool = [] })
</script>

<template>
  <div ref="containerRef" class="flex justify-center min-h-[200px]" />
</template>
