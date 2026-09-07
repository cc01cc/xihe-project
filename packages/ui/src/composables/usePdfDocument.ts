import { ref, shallowRef, computed, watch } from 'vue'
import { logger } from '../lib/logger'

type PdfSource = (() => string | ArrayBuffer | null) | string | ArrayBuffer | null

export function usePdfDocument(src: PdfSource) {
  // pdfjs proxy objects use private fields; deep Vue reactivity changes the
  // receiver for methods such as getPage() and breaks those private fields.
  const pdfDoc = shallowRef<any>(null)
  const numPages = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const resolvedSrc = computed(() => typeof src === 'function' ? src() : src)

  async function load(val: string | ArrayBuffer | null) {
    if (!val) return
    loading.value = true
    error.value = null
    try {
      const pdfjsLib = await import('pdfjs-dist')
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString()
      const data = typeof val === 'string' ? val : new Uint8Array(val as ArrayBuffer)
      pdfDoc.value = await (pdfjsLib.getDocument as any)({ data }).promise
      numPages.value = pdfDoc.value.numPages
    } catch (e: any) {
      logger.warn('Failed to load PDF: ' + (e.message || 'unknown'))
      error.value = e.message || 'Failed to load PDF'
    }
    loading.value = false
  }

  watch(resolvedSrc, (val) => {
    load(val)
  }, { immediate: true })

  return { pdfDoc, numPages, loading, error }
}
