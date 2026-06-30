import { describe, it, expect, vi } from 'vitest'

const mockGetDocument = vi.fn((...args: any[]) => ({
  promise: Promise.resolve({ numPages: 3 }),
}))
vi.mock('pdfjs-dist', () => ({
  default: {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: mockGetDocument,
  },
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: mockGetDocument,
}))

describe('usePdfDocument', () => {
  it('exports a function and handles null source', async () => {
    const { usePdfDocument } = await import('../../composables/usePdfDocument')
    const result = usePdfDocument(null)
    expect(typeof result.loading).toBe('object')
    expect(result.loading.value).toBe(false)
    expect(result.numPages.value).toBe(0)
  })

  it('calls getDocument with DocumentInitParameters object', async () => {
    const { usePdfDocument } = await import('../../composables/usePdfDocument')
    usePdfDocument('test.pdf')
    await new Promise(r => setTimeout(r, 50))
    expect(mockGetDocument).toHaveBeenCalledWith({ data: 'test.pdf' })
  })
})
