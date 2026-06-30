import { config } from '@vue/test-utils'
import { server } from './mocks/server'

// Start MSW server for API integration tests
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterAll(() => server.close())
afterEach(() => server.resetHandlers())

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

config.global.stubs = {
  Teleport: { template: '<div><slot /></div>' },
  'router-link': { template: '<a><slot /></a>' },
  'router-view': { template: '<div><slot /></div>' },
}
